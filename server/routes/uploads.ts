import { existsSync, renameSync, statSync, unlinkSync } from "fs";
import { open } from "node:fs/promises";
import path from "path";

import { requireAdmin } from "../auth";
import { LIMITS, UPLOAD_CHUNK_MAX_BYTES } from "../config";
import { randomToken } from "../crypto";
import { audit, db, inImmediateTx, type UploadRow } from "../db";
import { mimeTypeFor, resolveUploadPath, sanitizeFilename } from "../files";
import { ApiError, clientIp, ok, readJsonBody, v } from "../http";

function serializeUpload(u: UploadRow, activeLinksCount = 0) {
  const absPath = resolveUploadPath(u.stored_name);
  const existsOnDisk = u.status === "ready" && existsSync(absPath);
  return {
    id: u.id,
    originalName: u.original_name,
    storedName: u.stored_name,
    sizeBytes: u.size_bytes,
    receivedBytes: u.received_bytes,
    mimeType: u.mime_type,
    sha256: u.sha256,
    status: u.status,
    existsOnDisk,
    activeLinksCount,
    createdAt: u.created_at,
    completedAt: u.completed_at,
  };
}

export async function handleUploadsRoute(
  reqPath: string,
  req: Request,
  url: URL,
  server?: any,
): Promise<Response | null> {
  const ip = clientIp(req, server);

  if (reqPath === "/api/uploads" && req.method === "GET") {
    await requireAdmin(req);
    const rows = db
      .query<UploadRow, []>("SELECT * FROM uploads WHERE status != 'deleted' ORDER BY created_at DESC")
      .all();
    const linkCounts = new Map<string, number>();
    for (const row of db
      .query<{ upload_id: string; n: number }, []>(
        "SELECT upload_id, COUNT(*) AS n FROM links WHERE upload_id IS NOT NULL AND status IN ('active','paused') GROUP BY upload_id",
      )
      .all()) {
      linkCounts.set(row.upload_id, row.n);
    }
    return ok(
      {
        chunkMaxBytes: UPLOAD_CHUNK_MAX_BYTES,
        uploads: rows.map((u) => serializeUpload(u, linkCounts.get(u.id) ?? 0)),
      },
      req,
    );
  }

  if (reqPath === "/api/uploads/init" && req.method === "POST") {
    await requireAdmin(req);
    const body = await readJsonBody(req, LIMITS.apiBodyBytes);
    const rawName = v.str(body, "filename", { min: 1, max: 512 })!;
    const sizeBytes = v.int(body, "sizeBytes", { min: 0, max: Number.MAX_SAFE_INTEGER })!;
    const cleanName = sanitizeFilename(rawName);
    const id = randomToken(12);
    const ext = path.extname(cleanName).slice(0, 24);
    const storedName = `${id}_${cleanName.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80) || "upload"}${ext && !cleanName.endsWith(ext) ? ext : ""}`;
    const mimeType = mimeTypeFor(cleanName);
    const now = Date.now();

    // Ensure target .part file exists right away (supports 0-byte files)
    const partPath = `${resolveUploadPath(storedName)}.part`;
    const fh = await open(partPath, "w");
    await fh.close();

    db.prepare(
      `INSERT INTO uploads (id, original_name, stored_name, size_bytes, received_bytes, mime_type, sha256, status, created_at, completed_at)
       VALUES (?, ?, ?, ?, 0, ?, NULL, 'uploading', ?, NULL)`,
    ).run(id, cleanName, storedName, sizeBytes, mimeType, now);

    return ok(
      {
        upload: serializeUpload(db.query<UploadRow, [string]>("SELECT * FROM uploads WHERE id = ?").get(id)!),
        chunkMaxBytes: UPLOAD_CHUNK_MAX_BYTES,
      },
      req,
    );
  }

  const chunkMatch = reqPath.match(/^\/api\/uploads\/([a-f0-9]+)\/chunk$/);
  if (chunkMatch && req.method === "PUT") {
    await requireAdmin(req);
    if (server?.timeout) server.timeout(req, 0);

    const id = chunkMatch[1]!;
    const upload = db.query<UploadRow, [string]>("SELECT * FROM uploads WHERE id = ?").get(id);
    if (!upload) throw new ApiError(404, "Upload session not found");
    if (upload.status !== "uploading") throw new ApiError(400, "Upload is not in uploading state");

    const offsetRaw = url.searchParams.get("offset");
    if (!offsetRaw || !/^\d+$/.test(offsetRaw)) {
      throw new ApiError(400, "offset query parameter must be a non-negative integer");
    }
    const offset = Number(offsetRaw);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > upload.size_bytes) {
      throw new ApiError(400, "offset out of range");
    }

    const declaredLength = req.headers.get("content-length");
    if (declaredLength && Number(declaredLength) > UPLOAD_CHUNK_MAX_BYTES) {
      throw new ApiError(413, `Chunk exceeds limit of ${UPLOAD_CHUNK_MAX_BYTES} bytes`);
    }

    const buf = new Uint8Array(await req.arrayBuffer());
    if (buf.byteLength > UPLOAD_CHUNK_MAX_BYTES) {
      throw new ApiError(413, `Chunk exceeds limit of ${UPLOAD_CHUNK_MAX_BYTES} bytes`);
    }
    if (offset + buf.byteLength > upload.size_bytes) {
      throw new ApiError(400, "Chunk exceeds declared total upload size");
    }

    const partPath = `${resolveUploadPath(upload.stored_name)}.part`;
    const fh = await open(partPath, "r+");
    try {
      let written = 0;
      while (written < buf.byteLength) {
        const res = await fh.write(buf, written, buf.byteLength - written, offset + written);
        if (res.bytesWritten === 0) break;
        written += res.bytesWritten;
      }
    } finally {
      await fh.close();
    }

    const newReceived = Math.max(upload.received_bytes, offset + buf.byteLength);
    db.prepare("UPDATE uploads SET received_bytes = ? WHERE id = ?").run(newReceived, id);

    return ok({ id, offset, writtenBytes: buf.byteLength, receivedBytes: newReceived }, req);
  }

  const completeMatch = reqPath.match(/^\/api\/uploads\/([a-f0-9]+)\/complete$/);
  if (completeMatch && req.method === "POST") {
    await requireAdmin(req);
    const id = completeMatch[1]!;
    const upload = db.query<UploadRow, [string]>("SELECT * FROM uploads WHERE id = ?").get(id);
    if (!upload) throw new ApiError(404, "Upload session not found");
    if (upload.status === "ready") {
      return ok({ upload: serializeUpload(upload) }, req);
    }
    if (upload.status !== "uploading") throw new ApiError(400, "Upload cannot be completed");

    const partPath = `${resolveUploadPath(upload.stored_name)}.part`;
    const finalPath = resolveUploadPath(upload.stored_name);
    if (!existsSync(partPath)) {
      throw new ApiError(400, "Partial upload file missing on disk");
    }
    const st = statSync(partPath);
    if (st.size !== upload.size_bytes) {
      throw new ApiError(
        400,
        `Upload incomplete: expected ${upload.size_bytes} bytes, got ${st.size} bytes`,
      );
    }

    renameSync(partPath, finalPath);
    const now = Date.now();
    inImmediateTx(() => {
      db.prepare("UPDATE uploads SET status = 'ready', received_bytes = ?, completed_at = ? WHERE id = ?").run(
        st.size,
        now,
        id,
      );
      audit("upload.completed", {
        target: id,
        meta: { filename: upload.original_name, sizeBytes: st.size },
        ip,
      });
    });

    const readyRow = db.query<UploadRow, [string]>("SELECT * FROM uploads WHERE id = ?").get(id)!;
    return ok({ upload: serializeUpload(readyRow) }, req);
  }

  const deleteMatch = reqPath.match(/^\/api\/uploads\/([a-f0-9]+)$/);
  if (deleteMatch && req.method === "DELETE") {
    await requireAdmin(req);
    const id = deleteMatch[1]!;
    const upload = db.query<UploadRow, [string]>("SELECT * FROM uploads WHERE id = ?").get(id);
    if (!upload) throw new ApiError(404, "Upload not found");

    const activeLinks = db
      .query<{ n: number }, [string]>(
        "SELECT COUNT(*) AS n FROM links WHERE upload_id = ? AND status IN ('active','paused')",
      )
      .get(id)!.n;
    if (activeLinks > 0) {
      throw new ApiError(409, "Cannot delete an uploaded file while active or paused links still reference it");
    }

    const finalPath = resolveUploadPath(upload.stored_name);
    const partPath = `${finalPath}.part`;
    try {
      if (existsSync(finalPath)) unlinkSync(finalPath);
    } catch {}
    try {
      if (existsSync(partPath)) unlinkSync(partPath);
    } catch {}

    db.prepare("UPDATE uploads SET status = 'deleted' WHERE id = ?").run(id);
    audit("upload.deleted", { target: id, meta: { filename: upload.original_name }, ip });
    return ok({}, req);
  }

  return null;
}
