import { existsSync, readdirSync, realpathSync, statSync, type Stats } from "fs";
import path from "path";

import { FILES_DIR, UPLOADS_DIR } from "./config";
import { db, type LinkRow, type UploadRow } from "./db";
import { ApiError } from "./http";

const MIME_BY_EXT: Record<string, string> = {
  ".zip": "application/zip",
  ".7z": "application/x-7z-compressed",
  ".rar": "application/vnd.rar",
  ".tar": "application/x-tar",
  ".gz": "application/gzip",
  ".tgz": "application/gzip",
  ".xz": "application/x-xz",
  ".zst": "application/zstd",
  ".bz2": "application/x-bzip2",
  ".iso": "application/x-iso9660-image",
  ".img": "application/octet-stream",
  ".dmg": "application/x-apple-diskimage",
  ".exe": "application/vnd.microsoft.portable-executable",
  ".msi": "application/x-msi",
  ".apk": "application/vnd.android.package-archive",
  ".deb": "application/vnd.debian.binary-package",
  ".rpm": "application/x-rpm",
  ".pdf": "application/pdf",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".log": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".mp4": "video/mp4",
  ".mkv": "video/x-matroska",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".avi": "video/x-msvideo",
  ".mp3": "audio/mpeg",
  ".flac": "audio/flac",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".m4a": "audio/mp4",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".avif": "image/avif",
  ".wasm": "application/wasm",
  ".bin": "application/octet-stream",
  ".safetensors": "application/octet-stream",
  ".gguf": "application/octet-stream",
  ".parquet": "application/vnd.apache.parquet",
};

export function mimeTypeFor(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  return MIME_BY_EXT[ext] ?? "application/octet-stream";
}

export function sanitizeFilename(name: string): string {
  const base = path.posix.basename(name.replace(/\\/g, "/"));
  const cleaned = base
    .replace(/[\x00-\x1f\x7f]/g, "")
    .replace(/[<>:"/\\|?*]/g, "_")
    .replace(/^\.+/, "")
    .trim()
    .slice(0, 220);
  return cleaned || "file.bin";
}

export function toPosixRelPath(relPath: string): string {
  return relPath
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+/g, "/")
    .replace(/\/+$/, "");
}

export interface MountStatus {
  path: string;
  available: boolean;
  readable: boolean;
}

export function mountStatus(): MountStatus {
  if (!existsSync(FILES_DIR)) {
    return { path: FILES_DIR, available: false, readable: false };
  }
  try {
    const st = statSync(FILES_DIR);
    if (!st.isDirectory()) return { path: FILES_DIR, available: false, readable: false };
    readdirSync(FILES_DIR);
    return { path: FILES_DIR, available: true, readable: true };
  } catch {
    return { path: FILES_DIR, available: true, readable: false };
  }
}

function canonicalMountRoot(): string {
  if (!existsSync(FILES_DIR)) {
    throw new ApiError(404, `Mounted files directory does not exist: ${FILES_DIR}`);
  }
  const realRoot = realpathSync(FILES_DIR);
  const st = statSync(realRoot);
  if (!st.isDirectory()) {
    throw new ApiError(500, "Mounted files path is not a directory");
  }
  return realRoot;
}

function isInsideRoot(realRoot: string, candidate: string): boolean {
  if (candidate === realRoot) return true;
  const prefix = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep;
  return candidate.startsWith(prefix);
}

/**
 * Resolve a user-supplied relative path inside FILES_DIR using canonical realpathSync.
 * Rejects "..", null bytes, absolute paths, and symlink escapes outside FILES_DIR.
 */
export function resolveMountedPath(
  relPath: string,
  opts: { allowRoot?: boolean } = {},
): { absPath: string; relPath: string; stat: Stats } {
  if (relPath.includes("\0")) throw new ApiError(400, "Invalid path");
  const cleanRel = toPosixRelPath(relPath);
  const segments = cleanRel ? cleanRel.split("/") : [];
  if (segments.some((s) => s === "." || s === "..")) {
    throw new ApiError(403, "Path traversal is not allowed");
  }
  if (!cleanRel && !opts.allowRoot) {
    throw new ApiError(400, "File path is required");
  }

  const realRoot = canonicalMountRoot();
  const joined = cleanRel ? path.join(realRoot, ...segments) : realRoot;
  if (!existsSync(joined)) {
    throw new ApiError(404, "File or folder not found");
  }
  const resolved = realpathSync(joined);
  if (!isInsideRoot(realRoot, resolved)) {
    throw new ApiError(403, "Access denied outside mounted directory");
  }
  const st = statSync(resolved);
  return { absPath: resolved, relPath: cleanRel, stat: st };
}

export interface FileEntryDto {
  name: string;
  relPath: string;
  isDir: boolean;
  sizeBytes: number;
  mtimeMs: number;
  mimeType: string | null;
  activeLinksCount: number;
  sha256: string | null;
}

export interface FileListResult {
  mount: MountStatus;
  relPath: string;
  breadcrumbs: Array<{ name: string; relPath: string }>;
  entries: FileEntryDto[];
  totalEntries: number;
}

export function listMountedDir(
  relPath: string,
  opts: {
    q?: string;
    recursive?: boolean;
    sort?: "name" | "size" | "mtime";
    dir?: "asc" | "desc";
    limit?: number;
  } = {},
): FileListResult {
  const status = mountStatus();
  const cleanRel = toPosixRelPath(relPath);
  if (!status.available || !status.readable) {
    return {
      mount: status,
      relPath: cleanRel,
      breadcrumbs: buildBreadcrumbs(cleanRel),
      entries: [],
      totalEntries: 0,
    };
  }

  const resolved = resolveMountedPath(cleanRel, { allowRoot: true });
  if (!resolved.stat.isDirectory()) {
    throw new ApiError(400, "Target path is not a directory");
  }

  const realRoot = canonicalMountRoot();
  const q = (opts.q ?? "").trim().toLowerCase();
  const recursive = !!opts.recursive;
  const maxEntries = Math.min(2000, Math.max(1, opts.limit ?? 1000));

  // Preload active link counts per mount source_path and cached checksums
  const linkCounts = new Map<string, number>();
  for (const row of db
    .query<{ source_path: string; n: number }, []>(
      "SELECT source_path, COUNT(*) AS n FROM links WHERE source_type = 'mount' AND status IN ('active','paused') GROUP BY source_path",
    )
    .all()) {
    linkCounts.set(row.source_path, row.n);
  }
  const checksumMap = new Map<string, { size_bytes: number; mtime_ms: number; sha256: string }>();
  for (const row of db
    .query<{ file_key: string; size_bytes: number; mtime_ms: number; sha256: string }, []>(
      "SELECT file_key, size_bytes, mtime_ms, sha256 FROM file_checksums WHERE file_key LIKE 'mount:%'",
    )
    .all()) {
    checksumMap.set(row.file_key, row);
  }

  const collected: FileEntryDto[] = [];
  const visitedDirs = new Set<string>();

  const walk = (absDir: string, relDir: string, depth: number) => {
    if (collected.length >= maxEntries) return;
    if (visitedDirs.has(absDir)) return;
    visitedDirs.add(absDir);

    let dirents;
    try {
      dirents = readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const d of dirents) {
      if (collected.length >= maxEntries) break;
      if (d.name.startsWith(".")) continue; // hide dotfiles for safety
      const childJoined = path.join(absDir, d.name);
      let childReal: string;
      let childStat: Stats;
      try {
        childReal = realpathSync(childJoined);
        if (!isInsideRoot(realRoot, childReal)) continue;
        childStat = statSync(childReal);
      } catch {
        continue;
      }
      const isDir = childStat.isDirectory();
      const childRel = relDir ? `${relDir}/${d.name}` : d.name;

      if (isDir) {
        if (!recursive && (!q || d.name.toLowerCase().includes(q))) {
          collected.push({
            name: d.name,
            relPath: childRel,
            isDir: true,
            sizeBytes: 0,
            mtimeMs: Math.floor(childStat.mtimeMs),
            mimeType: null,
            activeLinksCount: 0,
            sha256: null,
          });
        }
        if (recursive && depth < 12) {
          walk(childReal, childRel, depth + 1);
        }
      } else if (childStat.isFile()) {
        if (q && !childRel.toLowerCase().includes(q)) continue;
        const mtimeMs = Math.floor(childStat.mtimeMs);
        const cached = checksumMap.get(`mount:${childRel}`);
        const sha256 =
          cached && cached.size_bytes === childStat.size && cached.mtime_ms === mtimeMs
            ? cached.sha256
            : null;
        collected.push({
          name: d.name,
          relPath: childRel,
          isDir: false,
          sizeBytes: childStat.size,
          mtimeMs,
          mimeType: mimeTypeFor(d.name),
          activeLinksCount: linkCounts.get(childRel) ?? 0,
          sha256,
        });
      }
    }
  };

  walk(resolved.absPath, resolved.relPath, 0);

  const sortBy = opts.sort ?? "name";
  const dirMul = opts.dir === "desc" ? -1 : 1;
  collected.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    if (sortBy === "size") return (a.sizeBytes - b.sizeBytes) * dirMul || a.name.localeCompare(b.name);
    if (sortBy === "mtime") return (a.mtimeMs - b.mtimeMs) * dirMul || a.name.localeCompare(b.name);
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }) * dirMul;
  });

  return {
    mount: status,
    relPath: resolved.relPath,
    breadcrumbs: buildBreadcrumbs(resolved.relPath),
    entries: collected,
    totalEntries: collected.length,
  };
}

function buildBreadcrumbs(relPath: string): Array<{ name: string; relPath: string }> {
  const crumbs = [{ name: "Root", relPath: "" }];
  if (!relPath) return crumbs;
  let acc = "";
  for (const part of relPath.split("/").filter(Boolean)) {
    acc = acc ? `${acc}/${part}` : part;
    crumbs.push({ name: part, relPath: acc });
  }
  return crumbs;
}

export function resolveUploadPath(storedName: string): string {
  const clean = path.basename(storedName);
  const full = path.resolve(UPLOADS_DIR, clean);
  const root = path.resolve(UPLOADS_DIR);
  if (!full.startsWith(root + path.sep)) {
    throw new ApiError(403, "Invalid upload storage path");
  }
  return full;
}

export interface ResolvedFileTarget {
  absPath: string;
  size: number;
  mtimeMs: number;
  exists: boolean;
  mimeType: string;
  fileKey: string;
}

export function resolveLinkFile(link: Pick<LinkRow, "source_type" | "source_path" | "upload_id" | "mime_type" | "download_filename">): ResolvedFileTarget {
  if (link.source_type === "upload") {
    if (!link.upload_id) {
      return { absPath: "", size: 0, mtimeMs: 0, exists: false, mimeType: link.mime_type, fileKey: "" };
    }
    const upload = db.query<UploadRow, [string]>("SELECT * FROM uploads WHERE id = ?").get(link.upload_id);
    if (!upload || upload.status !== "ready") {
      return { absPath: "", size: 0, mtimeMs: 0, exists: false, mimeType: link.mime_type, fileKey: `upload:${link.upload_id}` };
    }
    const absPath = resolveUploadPath(upload.stored_name);
    if (!existsSync(absPath)) {
      return { absPath, size: 0, mtimeMs: 0, exists: false, mimeType: link.mime_type, fileKey: `upload:${upload.id}` };
    }
    const st = statSync(absPath);
    if (!st.isFile()) {
      return { absPath, size: 0, mtimeMs: 0, exists: false, mimeType: link.mime_type, fileKey: `upload:${upload.id}` };
    }
    return {
      absPath,
      size: st.size,
      mtimeMs: Math.floor(st.mtimeMs),
      exists: true,
      mimeType: link.mime_type || upload.mime_type || mimeTypeFor(link.download_filename),
      fileKey: `upload:${upload.id}`,
    };
  }

  try {
    const resolved = resolveMountedPath(link.source_path, { allowRoot: false });
    if (!resolved.stat.isFile()) {
      return { absPath: "", size: 0, mtimeMs: 0, exists: false, mimeType: link.mime_type, fileKey: `mount:${link.source_path}` };
    }
    return {
      absPath: resolved.absPath,
      size: resolved.stat.size,
      mtimeMs: Math.floor(resolved.stat.mtimeMs),
      exists: true,
      mimeType: link.mime_type || mimeTypeFor(link.download_filename),
      fileKey: `mount:${resolved.relPath}`,
    };
  } catch {
    return {
      absPath: "",
      size: 0,
      mtimeMs: 0,
      exists: false,
      mimeType: link.mime_type,
      fileKey: `mount:${link.source_path}`,
    };
  }
}

export function getCachedChecksum(fileKey: string, sizeBytes: number, mtimeMs: number): string | null {
  if (!fileKey) return null;
  const row = db
    .query<{ size_bytes: number; mtime_ms: number; sha256: string }, [string]>(
      "SELECT size_bytes, mtime_ms, sha256 FROM file_checksums WHERE file_key = ?",
    )
    .get(fileKey);
  if (!row || row.size_bytes !== sizeBytes || row.mtime_ms !== mtimeMs) return null;
  return row.sha256;
}

export async function computeFileSha256(fileKey: string, absPath: string): Promise<{
  sha256: string;
  sizeBytes: number;
  mtimeMs: number;
  cached: boolean;
}> {
  const st = statSync(absPath);
  if (!st.isFile()) throw new ApiError(400, "Target is not a file");
  const sizeBytes = st.size;
  const mtimeMs = Math.floor(st.mtimeMs);
  const existing = getCachedChecksum(fileKey, sizeBytes, mtimeMs);
  if (existing) {
    return { sha256: existing, sizeBytes, mtimeMs, cached: true };
  }

  const { open } = await import("node:fs/promises");
  const fh = await open(absPath, "r");
  const hasher = new Bun.CryptoHasher("sha256");
  const buf = new Uint8Array(1024 * 1024);
  try {
    let offset = 0;
    while (offset < sizeBytes) {
      const { bytesRead } = await fh.read(buf, 0, buf.length, offset);
      if (bytesRead === 0) break;
      hasher.update(buf.subarray(0, bytesRead));
      offset += bytesRead;
    }
  } finally {
    await fh.close();
  }

  const sha256 = hasher.digest("hex");
  db.prepare(
    `INSERT INTO file_checksums (file_key, size_bytes, mtime_ms, sha256, computed_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(file_key) DO UPDATE SET
       size_bytes = excluded.size_bytes,
       mtime_ms = excluded.mtime_ms,
       sha256 = excluded.sha256,
       computed_at = excluded.computed_at`,
  ).run(fileKey, sizeBytes, mtimeMs, sha256, Date.now());

  return { sha256, sizeBytes, mtimeMs, cached: false };
}
