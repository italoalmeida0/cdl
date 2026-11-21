import { requireAdmin } from "../auth";
import { LIMITS } from "../config";
import { db, type UploadRow } from "../db";
import { computeFileSha256, listMountedDir, resolveMountedPath, resolveUploadPath } from "../files";
import { ApiError, ok, readJsonBody, v } from "../http";

export async function handleFilesRoute(path: string, req: Request, url: URL): Promise<Response | null> {
  if (path === "/api/files" && req.method === "GET") {
    await requireAdmin(req);
    const relPath = url.searchParams.get("path") ?? "";
    const q = url.searchParams.get("q") ?? "";
    const recursive = url.searchParams.get("recursive") === "true" || url.searchParams.get("recursive") === "1";
    const sortParam = url.searchParams.get("sort");
    const sort = sortParam === "size" || sortParam === "mtime" ? sortParam : "name";
    const dir = url.searchParams.get("dir") === "desc" ? "desc" : "asc";
    const data = listMountedDir(relPath, { q, recursive, sort, dir });
    return ok({ ...data }, req);
  }

  if (path === "/api/files/checksum" && req.method === "POST") {
    await requireAdmin(req);
    const body = await readJsonBody(req, LIMITS.apiBodyBytes);
    const sourceType = v.str(body, "sourceType");
    if (sourceType === "mount") {
      const sourcePath = v.str(body, "sourcePath", { min: 1, max: 1024 })!;
      const resolved = resolveMountedPath(sourcePath, { allowRoot: false });
      if (!resolved.stat.isFile()) throw new ApiError(400, "Target must be a file");
      const result = await computeFileSha256(`mount:${resolved.relPath}`, resolved.absPath);
      return ok(result, req);
    }
    if (sourceType === "upload") {
      const uploadId = v.str(body, "uploadId", { min: 1, max: 128 })!;
      const upload = db.query<UploadRow, [string]>("SELECT * FROM uploads WHERE id = ?").get(uploadId);
      if (!upload || upload.status !== "ready") throw new ApiError(404, "Upload not found");
      const absPath = resolveUploadPath(upload.stored_name);
      const result = await computeFileSha256(`upload:${upload.id}`, absPath);
      db.prepare("UPDATE uploads SET sha256 = ? WHERE id = ?").run(result.sha256, upload.id);
      return ok(result, req);
    }
    throw new ApiError(400, "sourceType must be 'mount' or 'upload'");
  }

  return null;
}
