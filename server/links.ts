import { existsSync, unlinkSync } from "fs";
import path from "path";

import { LIMITS } from "./config";
import { hashPassword, randomBase64UrlToken, randomToken, verifyPassword } from "./crypto";
import {
  audit,
  db,
  getSetting,
  inImmediateTx,
  setSetting,
  type LinkAuthorizedIpRow,
  type LinkRow,
  type UploadRow,
} from "./db";
import {
  getCachedChecksum,
  mimeTypeFor,
  resolveLinkFile,
  resolveMountedPath,
  resolveUploadPath,
  sanitizeFilename,
} from "./files";
import { ApiError, ipMatchesWhitelist, parseIpWhitelist, publicBaseUrlFor } from "./http";
import {
  abortLinkTransfers,
  activeBytesPerSecForLink,
  activeCountForLink,
  activeCountForLinkAndIp,
} from "./transfers";

export type ExpiryMode = "sliding" | "fixed" | "never";
export type EffectiveLinkStatus = "active" | "resume_only" | "paused" | "expired" | "revoked";

export interface LinkPolicyDefaults {
  expiryMode: ExpiryMode;
  idleTtlSec: number;
  fixedTtlSec: number;
  startedIpCanResume: boolean;
  resumeGraceSec: number;
  lockToFirstIp: boolean;
  maxDownloads: number | null;
  autoDeleteFile: boolean;
  allowInline: boolean;
}

const DEFAULT_POLICY: LinkPolicyDefaults = {
  expiryMode: "sliding",
  idleTtlSec: LIMITS.defaultSlidingTtlSec,
  fixedTtlSec: 24 * 3600,
  startedIpCanResume: true,
  resumeGraceSec: LIMITS.defaultResumeGraceSec,
  lockToFirstIp: false,
  maxDownloads: null,
  autoDeleteFile: false,
  allowInline: false,
};

export function getDefaultPolicy(): LinkPolicyDefaults {
  const raw = getSetting("default_link_policy");
  if (!raw) return { ...DEFAULT_POLICY };
  try {
    const parsed = JSON.parse(raw) as Partial<LinkPolicyDefaults>;
    return {
      expiryMode:
        parsed.expiryMode === "sliding" || parsed.expiryMode === "fixed" || parsed.expiryMode === "never"
          ? parsed.expiryMode
          : DEFAULT_POLICY.expiryMode,
      idleTtlSec:
        typeof parsed.idleTtlSec === "number" && parsed.idleTtlSec >= 60 ? parsed.idleTtlSec : DEFAULT_POLICY.idleTtlSec,
      fixedTtlSec:
        typeof parsed.fixedTtlSec === "number" && parsed.fixedTtlSec >= 60 ? parsed.fixedTtlSec : DEFAULT_POLICY.fixedTtlSec,
      startedIpCanResume:
        typeof parsed.startedIpCanResume === "boolean" ? parsed.startedIpCanResume : DEFAULT_POLICY.startedIpCanResume,
      resumeGraceSec:
        typeof parsed.resumeGraceSec === "number" && parsed.resumeGraceSec >= 0
          ? parsed.resumeGraceSec
          : DEFAULT_POLICY.resumeGraceSec,
      lockToFirstIp:
        typeof parsed.lockToFirstIp === "boolean" ? parsed.lockToFirstIp : DEFAULT_POLICY.lockToFirstIp,
      maxDownloads:
        parsed.maxDownloads === null || (typeof parsed.maxDownloads === "number" && parsed.maxDownloads >= 1)
          ? parsed.maxDownloads
          : DEFAULT_POLICY.maxDownloads,
      autoDeleteFile:
        typeof parsed.autoDeleteFile === "boolean" ? parsed.autoDeleteFile : DEFAULT_POLICY.autoDeleteFile,
      allowInline: typeof parsed.allowInline === "boolean" ? parsed.allowInline : DEFAULT_POLICY.allowInline,
    };
  } catch {
    return { ...DEFAULT_POLICY };
  }
}

export function saveDefaultPolicy(next: Partial<LinkPolicyDefaults>, ip?: string): LinkPolicyDefaults {
  const current = getDefaultPolicy();
  const merged: LinkPolicyDefaults = {
    expiryMode:
      next.expiryMode === "sliding" || next.expiryMode === "fixed" || next.expiryMode === "never"
        ? next.expiryMode
        : current.expiryMode,
    idleTtlSec:
      next.idleTtlSec !== undefined
        ? Math.min(365 * 24 * 3600, Math.max(60, Math.floor(next.idleTtlSec)))
        : current.idleTtlSec,
    fixedTtlSec:
      next.fixedTtlSec !== undefined
        ? Math.min(10 * 365 * 24 * 3600, Math.max(60, Math.floor(next.fixedTtlSec)))
        : current.fixedTtlSec,
    startedIpCanResume: next.startedIpCanResume ?? current.startedIpCanResume,
    resumeGraceSec:
      next.resumeGraceSec !== undefined
        ? Math.min(365 * 24 * 3600, Math.max(0, Math.floor(next.resumeGraceSec)))
        : current.resumeGraceSec,
    lockToFirstIp: next.lockToFirstIp ?? current.lockToFirstIp,
    maxDownloads:
      next.maxDownloads === null
        ? null
        : next.maxDownloads !== undefined
          ? Math.max(1, Math.floor(next.maxDownloads))
          : current.maxDownloads,
    autoDeleteFile: next.autoDeleteFile ?? current.autoDeleteFile,
    allowInline: next.allowInline ?? current.allowInline,
  };
  setSetting("default_link_policy", JSON.stringify(merged));
  audit("settings.default_policy", { meta: merged, ip });
  return merged;
}

export function parseWhitelistJson(raw: string): string[] {
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function maxResumeUntil(
  link: LinkRow,
  authorizedIps: LinkAuthorizedIpRow[],
): number | null {
  if (!link.started_ip_can_resume || authorizedIps.length === 0) return null;
  if (link.resume_grace_sec === 0) return Number.POSITIVE_INFINITY;
  let max = 0;
  for (const row of authorizedIps) {
    const until = row.last_activity_at + link.resume_grace_sec * 1000;
    if (until > max) max = until;
  }
  return max > 0 ? max : null;
}

export function isIpWithinResumeWindow(
  link: LinkRow,
  authIp: LinkAuthorizedIpRow | undefined,
  now: number,
  activeIpCount: number,
): boolean {
  if (!link.started_ip_can_resume || !authIp) return false;
  if (activeIpCount > 0) return true;
  if (link.resume_grace_sec === 0) return true;
  return authIp.last_activity_at + link.resume_grace_sec * 1000 > now;
}

export function computeEffectiveStatus(
  link: LinkRow,
  now: number,
  activeCount: number,
  authorizedIps: LinkAuthorizedIpRow[],
): { effectiveStatus: EffectiveLinkStatus; effectiveExpiresAt: number | null; resumeUntil: number | null } {
  if (link.status === "revoked") {
    return { effectiveStatus: "revoked", effectiveExpiresAt: link.expires_at, resumeUntil: null };
  }
  if (link.status === "paused") {
    return { effectiveStatus: "paused", effectiveExpiresAt: link.expires_at, resumeUntil: null };
  }
  if (link.status === "expired") {
    return { effectiveStatus: "expired", effectiveExpiresAt: link.expires_at, resumeUntil: null };
  }

  // Hard cap check
  const hardExpired = link.hard_expires_at !== null && now >= link.hard_expires_at;
  const deadline =
    link.hard_expires_at !== null && link.expires_at !== null
      ? Math.min(link.expires_at, link.hard_expires_at)
      : link.hard_expires_at ?? link.expires_at;

  const primaryExpired =
    hardExpired || (link.expiry_mode !== "never" && deadline !== null && now >= deadline);

  if (!primaryExpired) {
    return { effectiveStatus: "active", effectiveExpiresAt: deadline, resumeUntil: null };
  }

  // Primary deadline passed while status is 'active'.
  // Active transfers always finish; started IPs within resume_grace_sec keep the link in 'resume_only'.
  if (activeCount > 0) {
    return {
      effectiveStatus: "resume_only",
      effectiveExpiresAt: deadline,
      resumeUntil: maxResumeUntil(link, authorizedIps),
    };
  }

  if (link.started_ip_can_resume && authorizedIps.length > 0) {
    const anyValid = authorizedIps.some((row) =>
      isIpWithinResumeWindow(link, row, now, 0),
    );
    if (anyValid) {
      return {
        effectiveStatus: "resume_only",
        effectiveExpiresAt: deadline,
        resumeUntil: maxResumeUntil(link, authorizedIps),
      };
    }
  }

  return { effectiveStatus: "expired", effectiveExpiresAt: deadline, resumeUntil: null };
}

export interface LinkDto {
  id: string;
  token: string;
  publicUrl: string;
  label: string;
  sourceType: "mount" | "upload";
  sourcePath: string;
  uploadId: string | null;
  downloadFilename: string;
  fileSize: number;
  mimeType: string;
  fileExists: boolean;
  sha256: string | null;
  expiryMode: ExpiryMode;
  idleTtlSec: number | null;
  expiresAt: number | null;
  hardExpiresAt: number | null;
  startedIpCanResume: boolean;
  resumeGraceSec: number;
  lockToFirstIp: boolean;
  lockedIp: string | null;
  ipWhitelist: string[];
  maxDownloads: number | null;
  downloadCount: number;
  totalBytesServed: number;
  hasPassword: boolean;
  allowInline: boolean;
  autoDeleteFile: boolean;
  maxSpeedKbps: number | null;
  notes: string;
  status: LinkRow["status"];
  effectiveStatus: EffectiveLinkStatus;
  resumeUntil: number | null;
  activeTransfersCount: number;
  activeBytesPerSec: number;
  authorizedIpsCount: number;
  createdAt: number;
  lastActivityAt: number | null;
}

export function serializeLink(
  link: LinkRow,
  baseUrl: string,
  now = Date.now(),
  preloadedAuthIps?: LinkAuthorizedIpRow[],
): LinkDto {
  const authorizedIps =
    preloadedAuthIps ??
    db
      .query<LinkAuthorizedIpRow, [string]>("SELECT * FROM link_authorized_ips WHERE link_id = ? ORDER BY last_activity_at DESC")
      .all(link.id);
  const activeCount = activeCountForLink(link.id);
  const { effectiveStatus, effectiveExpiresAt, resumeUntil } = computeEffectiveStatus(
    link,
    now,
    activeCount,
    authorizedIps,
  );
  const resolvedFile = resolveLinkFile(link);
  const sha256 = resolvedFile.exists
    ? getCachedChecksum(resolvedFile.fileKey, resolvedFile.size, resolvedFile.mtimeMs)
    : null;
  const cleanBase = baseUrl.replace(/\/+$/, "");
  const encodedFilename = encodeURIComponent(link.download_filename);
  const publicUrl = `${cleanBase}/d/${link.token}/${encodedFilename}`;

  return {
    id: link.id,
    token: link.token,
    publicUrl,
    label: link.label,
    sourceType: link.source_type,
    sourcePath: link.source_path,
    uploadId: link.upload_id,
    downloadFilename: link.download_filename,
    fileSize: resolvedFile.exists ? resolvedFile.size : link.file_size,
    mimeType: link.mime_type,
    fileExists: resolvedFile.exists,
    sha256,
    expiryMode: link.expiry_mode,
    idleTtlSec: link.idle_ttl_sec,
    expiresAt: effectiveExpiresAt,
    hardExpiresAt: link.hard_expires_at,
    startedIpCanResume: !!link.started_ip_can_resume,
    resumeGraceSec: link.resume_grace_sec,
    lockToFirstIp: !!link.lock_to_first_ip,
    lockedIp: link.locked_ip,
    ipWhitelist: parseWhitelistJson(link.ip_whitelist),
    maxDownloads: link.max_downloads,
    downloadCount: link.download_count,
    totalBytesServed: link.total_bytes_served,
    hasPassword: !!link.password_hash,
    allowInline: !!link.allow_inline,
    autoDeleteFile: !!link.auto_delete_file,
    maxSpeedKbps: link.max_speed_kbps,
    notes: link.notes,
    status: link.status,
    effectiveStatus,
    resumeUntil: resumeUntil === Number.POSITIVE_INFINITY ? null : resumeUntil,
    activeTransfersCount: activeCount,
    activeBytesPerSec: activeBytesPerSecForLink(link.id),
    authorizedIpsCount: authorizedIps.length,
    createdAt: link.created_at,
    lastActivityAt: link.last_activity_at,
  };
}

export interface CreateLinkInput {
  sourceType: "mount" | "upload";
  sourcePath?: string;
  uploadId?: string;
  label?: string;
  downloadFilename?: string;
  expiryMode?: ExpiryMode;
  idleTtlSec?: number;
  fixedTtlSec?: number;
  expiresAt?: number | null;
  hardExpiresAt?: number | null;
  startedIpCanResume?: boolean;
  resumeGraceSec?: number;
  lockToFirstIp?: boolean;
  ipWhitelist?: string[] | string;
  maxDownloads?: number | null;
  password?: string | null;
  allowInline?: boolean;
  autoDeleteFile?: boolean;
  maxSpeedKbps?: number | null;
  notes?: string;
}

export async function createLink(input: CreateLinkInput, baseUrl: string, actorIp?: string): Promise<LinkDto> {
  const defaults = getDefaultPolicy();
  const sourceType = input.sourceType;
  if (sourceType !== "mount" && sourceType !== "upload") {
    throw new ApiError(400, "sourceType must be 'mount' or 'upload'");
  }

  let sourcePath = "";
  let uploadId: string | null = null;
  let fileSize = 0;
  let originalName = "file.bin";
  let mimeType = "application/octet-stream";

  if (sourceType === "mount") {
    if (!input.sourcePath) throw new ApiError(400, "sourcePath is required for mounted files");
    const resolved = resolveMountedPath(input.sourcePath, { allowRoot: false });
    if (!resolved.stat.isFile()) {
      throw new ApiError(400, "Selected mounted path must be a regular file");
    }
    sourcePath = resolved.relPath;
    fileSize = resolved.stat.size;
    originalName = path.posix.basename(resolved.relPath);
    mimeType = mimeTypeFor(originalName);
  } else {
    if (!input.uploadId) throw new ApiError(400, "uploadId is required for uploaded files");
    const upload = db.query<UploadRow, [string]>("SELECT * FROM uploads WHERE id = ?").get(input.uploadId);
    if (!upload || upload.status !== "ready") {
      throw new ApiError(404, "Uploaded file not found or not ready");
    }
    const absPath = resolveUploadPath(upload.stored_name);
    if (!existsSync(absPath)) {
      throw new ApiError(404, "Uploaded file missing on disk");
    }
    uploadId = upload.id;
    sourcePath = upload.stored_name;
    fileSize = upload.size_bytes;
    originalName = upload.original_name;
    mimeType = upload.mime_type || mimeTypeFor(originalName);
  }

  const expiryMode: ExpiryMode = input.expiryMode ?? defaults.expiryMode;
  if (expiryMode !== "sliding" && expiryMode !== "fixed" && expiryMode !== "never") {
    throw new ApiError(400, "Invalid expiryMode");
  }

  const now = Date.now();
  let idleTtlSec: number | null = null;
  let expiresAt: number | null = null;
  let hardExpiresAt: number | null = input.hardExpiresAt ?? null;

  if (expiryMode === "sliding") {
    idleTtlSec = Math.floor(input.idleTtlSec ?? defaults.idleTtlSec);
    if (!Number.isFinite(idleTtlSec) || idleTtlSec < 60 || idleTtlSec > 365 * 24 * 3600) {
      throw new ApiError(400, "idleTtlSec must be between 60 seconds and 365 days");
    }
    expiresAt = now + idleTtlSec * 1000;
    if (hardExpiresAt !== null && hardExpiresAt <= now) {
      throw new ApiError(400, "hardExpiresAt must be in the future");
    }
    if (hardExpiresAt !== null && expiresAt > hardExpiresAt) {
      expiresAt = hardExpiresAt;
    }
  } else if (expiryMode === "fixed") {
    if (input.expiresAt !== undefined && input.expiresAt !== null) {
      if (!Number.isFinite(input.expiresAt) || input.expiresAt <= now) {
        throw new ApiError(400, "expiresAt must be a future timestamp");
      }
      expiresAt = Math.floor(input.expiresAt);
    } else {
      const ttl = Math.floor(input.fixedTtlSec ?? defaults.fixedTtlSec);
      if (!Number.isFinite(ttl) || ttl < 60 || ttl > 10 * 365 * 24 * 3600) {
        throw new ApiError(400, "fixedTtlSec must be between 60 seconds and 10 years");
      }
      expiresAt = now + ttl * 1000;
    }
    hardExpiresAt = null;
  } else {
    expiresAt = null;
    hardExpiresAt = null;
  }

  const startedIpCanResume = input.startedIpCanResume ?? defaults.startedIpCanResume;
  const resumeGraceSec = Math.floor(input.resumeGraceSec ?? defaults.resumeGraceSec);
  if (!Number.isFinite(resumeGraceSec) || resumeGraceSec < 0 || resumeGraceSec > 365 * 24 * 3600) {
    throw new ApiError(400, "resumeGraceSec must be between 0 and 365 days");
  }

  const lockToFirstIp = input.lockToFirstIp ?? defaults.lockToFirstIp;
  const ipWhitelist = parseIpWhitelist(input.ipWhitelist ?? []);
  const maxDownloads =
    input.maxDownloads === undefined
      ? defaults.maxDownloads
      : input.maxDownloads === null
        ? null
        : Math.floor(input.maxDownloads);
  if (maxDownloads !== null && (!Number.isFinite(maxDownloads) || maxDownloads < 1 || maxDownloads > 1_000_000)) {
    throw new ApiError(400, "maxDownloads must be >= 1");
  }

  const maxSpeedKbps =
    input.maxSpeedKbps === undefined || input.maxSpeedKbps === null
      ? null
      : Math.floor(input.maxSpeedKbps);
  if (maxSpeedKbps !== null && (!Number.isFinite(maxSpeedKbps) || maxSpeedKbps < 1)) {
    throw new ApiError(400, "maxSpeedKbps must be >= 1");
  }

  let passwordHash: string | null = null;
  if (input.password && input.password.length > 0) {
    if (input.password.length > 256) throw new ApiError(400, "Link password too long");
    passwordHash = await hashPassword(input.password);
  }

  const downloadFilename = sanitizeFilename(input.downloadFilename?.trim() || originalName);
  const label = (input.label ?? "").trim().slice(0, 140) || downloadFilename;
  const notes = (input.notes ?? "").trim().slice(0, 1000);
  const allowInline = input.allowInline ?? defaults.allowInline;
  const autoDeleteFile = sourceType === "upload" ? (input.autoDeleteFile ?? defaults.autoDeleteFile) : false;

  const id = randomToken(12);
  const token = randomBase64UrlToken(18);

  db.prepare(
    `INSERT INTO links (
      id, token, label, source_type, source_path, upload_id, download_filename, file_size, mime_type,
      expiry_mode, idle_ttl_sec, expires_at, hard_expires_at, started_ip_can_resume, resume_grace_sec,
      lock_to_first_ip, locked_ip, ip_whitelist, max_downloads, download_count, total_bytes_served,
      password_hash, allow_inline, auto_delete_file, max_speed_kbps, notes, status, created_at, last_activity_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, 0, 0, ?, ?, ?, ?, ?, 'active', ?, NULL)`,
  ).run(
    id,
    token,
    label,
    sourceType,
    sourcePath,
    uploadId,
    downloadFilename,
    fileSize,
    mimeType,
    expiryMode,
    idleTtlSec,
    expiresAt,
    hardExpiresAt,
    startedIpCanResume ? 1 : 0,
    resumeGraceSec,
    lockToFirstIp ? 1 : 0,
    JSON.stringify(ipWhitelist),
    maxDownloads,
    passwordHash,
    allowInline ? 1 : 0,
    autoDeleteFile ? 1 : 0,
    maxSpeedKbps,
    notes,
    now,
  );

  const row = db.query<LinkRow, [string]>("SELECT * FROM links WHERE id = ?").get(id)!;
  audit("link.created", {
    target: id,
    meta: { label, sourceType, sourcePath, expiryMode, idleTtlSec, expiresAt },
    ip: actorIp,
  });
  return serializeLink(row, baseUrl, now, []);
}

export interface UpdateLinkInput {
  label?: string;
  downloadFilename?: string;
  notes?: string;
  expiryMode?: ExpiryMode;
  idleTtlSec?: number | null;
  expiresAt?: number | null;
  hardExpiresAt?: number | null;
  startedIpCanResume?: boolean;
  resumeGraceSec?: number;
  lockToFirstIp?: boolean;
  ipWhitelist?: string[] | string;
  maxDownloads?: number | null;
  password?: string | null;
  clearPassword?: boolean;
  allowInline?: boolean;
  autoDeleteFile?: boolean;
  maxSpeedKbps?: number | null;
  status?: "active" | "paused";
}

export async function updateLink(
  id: string,
  input: UpdateLinkInput,
  baseUrl: string,
  actorIp?: string,
): Promise<LinkDto> {
  const existing = db.query<LinkRow, [string]>("SELECT * FROM links WHERE id = ?").get(id);
  if (!existing) throw new ApiError(404, "Link not found");
  if (existing.status === "revoked") throw new ApiError(400, "Cannot edit a revoked link");

  const now = Date.now();
  const label = input.label !== undefined ? input.label.trim().slice(0, 140) || existing.download_filename : existing.label;
  const downloadFilename =
    input.downloadFilename !== undefined ? sanitizeFilename(input.downloadFilename.trim()) : existing.download_filename;
  const notes = input.notes !== undefined ? input.notes.trim().slice(0, 1000) : existing.notes;
  const expiryMode = input.expiryMode ?? existing.expiry_mode;
  let idleTtlSec = input.idleTtlSec !== undefined ? input.idleTtlSec : existing.idle_ttl_sec;
  let expiresAt = input.expiresAt !== undefined ? input.expiresAt : existing.expires_at;
  let hardExpiresAt = input.hardExpiresAt !== undefined ? input.hardExpiresAt : existing.hard_expires_at;

  if (expiryMode === "sliding") {
    idleTtlSec = Math.floor(idleTtlSec ?? LIMITS.defaultSlidingTtlSec);
    if (idleTtlSec < 60 || idleTtlSec > 365 * 24 * 3600) {
      throw new ApiError(400, "idleTtlSec must be between 60 seconds and 365 days");
    }
    if (input.expiryMode === "sliding" && input.expiresAt === undefined) {
      expiresAt = now + idleTtlSec * 1000;
    }
    if (hardExpiresAt !== null && expiresAt !== null && expiresAt > hardExpiresAt) {
      expiresAt = hardExpiresAt;
    }
  } else if (expiryMode === "fixed") {
    idleTtlSec = null;
    hardExpiresAt = null;
    if (expiresAt === null) {
      expiresAt = now + 24 * 3600 * 1000;
    }
  } else {
    idleTtlSec = null;
    expiresAt = null;
    hardExpiresAt = null;
  }

  const startedIpCanResume =
    input.startedIpCanResume !== undefined ? (input.startedIpCanResume ? 1 : 0) : existing.started_ip_can_resume;
  const resumeGraceSec =
    input.resumeGraceSec !== undefined
      ? Math.min(365 * 24 * 3600, Math.max(0, Math.floor(input.resumeGraceSec)))
      : existing.resume_grace_sec;
  const lockToFirstIp = input.lockToFirstIp !== undefined ? (input.lockToFirstIp ? 1 : 0) : existing.lock_to_first_ip;
  const ipWhitelist =
    input.ipWhitelist !== undefined ? JSON.stringify(parseIpWhitelist(input.ipWhitelist)) : existing.ip_whitelist;
  const maxDownloads =
    input.maxDownloads !== undefined
      ? input.maxDownloads === null
        ? null
        : Math.max(1, Math.floor(input.maxDownloads))
      : existing.max_downloads;
  const maxSpeedKbps =
    input.maxSpeedKbps !== undefined
      ? input.maxSpeedKbps === null
        ? null
        : Math.max(1, Math.floor(input.maxSpeedKbps))
      : existing.max_speed_kbps;

  let passwordHash = existing.password_hash;
  if (input.clearPassword) {
    passwordHash = null;
  } else if (input.password && input.password.length > 0) {
    passwordHash = await hashPassword(input.password);
  }

  const allowInline = input.allowInline !== undefined ? (input.allowInline ? 1 : 0) : existing.allow_inline;
  const autoDeleteFile =
    existing.source_type === "upload" && input.autoDeleteFile !== undefined
      ? input.autoDeleteFile
        ? 1
        : 0
      : existing.auto_delete_file;

  let nextStatus = existing.status;
  if (input.status === "paused" || input.status === "active") {
    nextStatus = input.status;
  }
  if (nextStatus === "expired" && (expiryMode === "never" || (expiresAt !== null && expiresAt > now))) {
    nextStatus = "active";
  }

  db.prepare(
    `UPDATE links SET
      label = ?, download_filename = ?, notes = ?, expiry_mode = ?, idle_ttl_sec = ?,
      expires_at = ?, hard_expires_at = ?, started_ip_can_resume = ?, resume_grace_sec = ?,
      lock_to_first_ip = ?, ip_whitelist = ?, max_downloads = ?, password_hash = ?,
      allow_inline = ?, auto_delete_file = ?, max_speed_kbps = ?, status = ?
     WHERE id = ?`,
  ).run(
    label,
    downloadFilename,
    notes,
    expiryMode,
    idleTtlSec,
    expiresAt,
    hardExpiresAt,
    startedIpCanResume,
    resumeGraceSec,
    lockToFirstIp,
    ipWhitelist,
    maxDownloads,
    passwordHash,
    allowInline,
    autoDeleteFile,
    maxSpeedKbps,
    nextStatus,
    id,
  );

  const updated = db.query<LinkRow, [string]>("SELECT * FROM links WHERE id = ?").get(id)!;
  audit("link.updated", { target: id, ip: actorIp });
  return serializeLink(updated, baseUrl, now);
}

export function extendLink(id: string, seconds: number, baseUrl: string, actorIp?: string): LinkDto {
  const existing = db.query<LinkRow, [string]>("SELECT * FROM links WHERE id = ?").get(id);
  if (!existing) throw new ApiError(404, "Link not found");
  if (existing.status === "revoked") throw new ApiError(400, "Cannot extend a revoked link");
  if (!Number.isFinite(seconds) || seconds < 60 || seconds > 365 * 24 * 3600) {
    throw new ApiError(400, "Extension must be between 60 seconds and 365 days");
  }

  const now = Date.now();
  const baseDeadline = existing.expires_at && existing.expires_at > now ? existing.expires_at : now;
  let nextExpiresAt: number | null = baseDeadline + Math.floor(seconds) * 1000;
  let nextHard = existing.hard_expires_at;
  if (nextHard !== null && nextExpiresAt > nextHard) {
    nextHard = nextExpiresAt;
  }
  const nextStatus = existing.status === "expired" ? "active" : existing.status;

  db.prepare("UPDATE links SET expires_at = ?, hard_expires_at = ?, status = ? WHERE id = ?").run(
    nextExpiresAt,
    nextHard,
    nextStatus,
    id,
  );

  const updated = db.query<LinkRow, [string]>("SELECT * FROM links WHERE id = ?").get(id)!;
  audit("link.extended", { target: id, meta: { seconds, nextExpiresAt }, ip: actorIp });
  return serializeLink(updated, baseUrl, now);
}

export function unlockLinkIp(id: string, baseUrl: string, actorIp?: string): LinkDto {
  const existing = db.query<LinkRow, [string]>("SELECT * FROM links WHERE id = ?").get(id);
  if (!existing) throw new ApiError(404, "Link not found");
  db.prepare("UPDATE links SET locked_ip = NULL WHERE id = ?").run(id);
  audit("link.ip_unlocked", { target: id, meta: { previousIp: existing.locked_ip }, ip: actorIp });
  const updated = db.query<LinkRow, [string]>("SELECT * FROM links WHERE id = ?").get(id)!;
  return serializeLink(updated, baseUrl, Date.now());
}

export function revokeLink(id: string, baseUrl: string, actorIp?: string): LinkDto {
  const existing = db.query<LinkRow, [string]>("SELECT * FROM links WHERE id = ?").get(id);
  if (!existing) throw new ApiError(404, "Link not found");
  db.prepare("UPDATE links SET status = 'revoked' WHERE id = ?").run(id);
  const killed = abortLinkTransfers(id);
  audit("link.revoked", { target: id, meta: { killedTransfers: killed }, ip: actorIp });
  const updated = db.query<LinkRow, [string]>("SELECT * FROM links WHERE id = ?").get(id)!;
  return serializeLink(updated, baseUrl, Date.now());
}

export function deleteLink(id: string, actorIp?: string): void {
  const existing = db.query<LinkRow, [string]>("SELECT * FROM links WHERE id = ?").get(id);
  if (!existing) throw new ApiError(404, "Link not found");
  abortLinkTransfers(id);
  db.prepare("DELETE FROM links WHERE id = ?").run(id);
  audit("link.deleted", { target: id, meta: { label: existing.label }, ip: actorIp });
}

export function listLinks(
  baseUrl: string,
  opts: { q?: string; status?: string; sourceType?: string } = {},
): LinkDto[] {
  const rows = db.query<LinkRow, []>("SELECT * FROM links ORDER BY created_at DESC").all();
  const authIpsByLink = new Map<string, LinkAuthorizedIpRow[]>();
  for (const row of db.query<LinkAuthorizedIpRow, []>("SELECT * FROM link_authorized_ips ORDER BY last_activity_at DESC").all()) {
    let list = authIpsByLink.get(row.link_id);
    if (!list) {
      list = [];
      authIpsByLink.set(row.link_id, list);
    }
    list.push(row);
  }

  const now = Date.now();
  const q = (opts.q ?? "").trim().toLowerCase();
  const statusFilter = (opts.status ?? "").trim();
  const sourceFilter = (opts.sourceType ?? "").trim();

  const out: LinkDto[] = [];
  for (const row of rows) {
    if (sourceFilter && row.source_type !== sourceFilter) continue;
    const dto = serializeLink(row, baseUrl, now, authIpsByLink.get(row.id) ?? []);
    if (statusFilter && statusFilter !== "all" && dto.effectiveStatus !== statusFilter) continue;
    if (q) {
      const hay = `${dto.label} ${dto.downloadFilename} ${dto.sourcePath} ${dto.token}`.toLowerCase();
      if (!hay.includes(q)) continue;
    }
    out.push(dto);
  }
  return out;
}

export function getLinkDetail(id: string, baseUrl: string) {
  const row = db.query<LinkRow, [string]>("SELECT * FROM links WHERE id = ?").get(id);
  if (!row) throw new ApiError(404, "Link not found");
  const authorizedIps = db
    .query<LinkAuthorizedIpRow, [string]>(
      "SELECT * FROM link_authorized_ips WHERE link_id = ? ORDER BY last_activity_at DESC",
    )
    .all(id);
  const events = db
    .query<{
      id: number;
      ts: number;
      ip: string;
      user_agent: string;
      method: string;
      range_start: number | null;
      range_end: number | null;
      bytes_sent: number;
      status: number;
      outcome: string;
      duration_ms: number;
    }, [string]>(
      "SELECT id, ts, ip, user_agent, method, range_start, range_end, bytes_sent, status, outcome, duration_ms FROM download_events WHERE link_id = ? ORDER BY ts DESC LIMIT 50",
    )
    .all(id);

  return {
    link: serializeLink(row, baseUrl, Date.now(), authorizedIps),
    authorizedIps: authorizedIps.map((a) => ({
      ip: a.ip,
      firstStartedAt: a.first_started_at,
      lastActivityAt: a.last_activity_at,
      requestsCount: a.requests_count,
      bytesSent: a.bytes_sent,
    })),
    events: events.map((e) => ({
      id: e.id,
      ts: e.ts,
      ip: e.ip,
      userAgent: e.user_agent,
      method: e.method,
      rangeStart: e.range_start,
      rangeEnd: e.range_end,
      bytesSent: e.bytes_sent,
      status: e.status,
      outcome: e.outcome,
      durationMs: e.duration_ms,
    })),
  };
}

// ===== Download Authorization & Activity Refresh =====

export type AuthorizeResult =
  | {
      allowed: true;
      link: LinkRow;
      isResumeGraceAccess: boolean;
      countedDownload: boolean;
    }
  | {
      allowed: false;
      status: number;
      code: string;
      message: string;
      outcome: string;
      needsPasswordPrompt?: boolean;
    };

export async function authorizeDownloadRequest(opts: {
  token: string;
  ip: string;
  isHead: boolean;
  rangeStart: number | null;
  suppliedPassword: string | null;
  unlockCookieValid: boolean;
}): Promise<AuthorizeResult> {
  const link = db.query<LinkRow, [string]>("SELECT * FROM links WHERE token = ?").get(opts.token);
  if (!link) {
    return { allowed: false, status: 404, code: "not_found", message: "Download link not found", outcome: "not_found" };
  }
  if (link.status === "revoked") {
    return { allowed: false, status: 410, code: "revoked", message: "This download link has been revoked", outcome: "revoked" };
  }
  if (link.status === "paused") {
    return { allowed: false, status: 423, code: "paused", message: "This download link is temporarily paused", outcome: "paused" };
  }
  if (link.status === "expired") {
    return { allowed: false, status: 410, code: "expired", message: "This download link has expired", outcome: "expired" };
  }

  // IP Whitelist check
  const whitelist = parseWhitelistJson(link.ip_whitelist);
  if (whitelist.length > 0 && !ipMatchesWhitelist(opts.ip, whitelist)) {
    return {
      allowed: false,
      status: 403,
      code: "ip_not_whitelisted",
      message: "Your IP address is not permitted to access this link",
      outcome: "denied_whitelist",
    };
  }

  // Lock to first IP check
  if (link.lock_to_first_ip && link.locked_ip && link.locked_ip !== opts.ip) {
    return {
      allowed: false,
      status: 403,
      code: "ip_locked",
      message: "This link is locked to another IP address",
      outcome: "denied_ip_lock",
    };
  }

  // Password check
  if (link.password_hash) {
    let authed = opts.unlockCookieValid;
    if (!authed && opts.suppliedPassword !== null) {
      authed = await verifyPassword(opts.suppliedPassword, link.password_hash);
    }
    if (!authed) {
      return {
        allowed: false,
        status: 401,
        code: "password_required",
        message: "Password required to download this file",
        outcome: opts.suppliedPassword !== null ? "denied_bad_password" : "password_required",
        needsPasswordPrompt: true,
      };
    }
  }

  const now = Date.now();
  const activeForIp = activeCountForLinkAndIp(link.id, opts.ip);

  // Atomic authorization + state update inside IMMEDIATE SQLite transaction
  return inImmediateTx<AuthorizeResult>(() => {
    const fresh = db.query<LinkRow, [string]>("SELECT * FROM links WHERE id = ?").get(link.id);
    if (!fresh || fresh.status !== "active") {
      return {
        allowed: false,
        status: 410,
        code: fresh?.status ?? "expired",
        message: "This download link is no longer active",
        outcome: fresh?.status ?? "expired",
      };
    }

    if (fresh.lock_to_first_ip && fresh.locked_ip && fresh.locked_ip !== opts.ip) {
      return {
        allowed: false,
        status: 403,
        code: "ip_locked",
        message: "This link is locked to another IP address",
        outcome: "denied_ip_lock",
      };
    }

    const authIp = db
      .query<LinkAuthorizedIpRow, [string, string]>(
        "SELECT * FROM link_authorized_ips WHERE link_id = ? AND ip = ?",
      )
      .get(fresh.id, opts.ip) ?? undefined;

    const deadline =
      fresh.hard_expires_at !== null && fresh.expires_at !== null
        ? Math.min(fresh.expires_at, fresh.hard_expires_at)
        : fresh.hard_expires_at ?? fresh.expires_at;

    const primaryExpired =
      (fresh.hard_expires_at !== null && now >= fresh.hard_expires_at) ||
      (fresh.expiry_mode !== "never" && deadline !== null && now >= deadline);

    let isResumeGraceAccess = false;
    if (primaryExpired) {
      if (isIpWithinResumeWindow(fresh, authIp, now, activeForIp)) {
        isResumeGraceAccess = true;
      } else {
        return {
          allowed: false,
          status: 410,
          code: "expired",
          message: "This download link has expired",
          outcome: "expired",
        };
      }
    }

    // Determine whether this GET counts against max_downloads
    const isRangeContinuation =
      authIp !== undefined &&
      ((opts.rangeStart !== null && opts.rangeStart > 0) ||
        activeForIp > 0 ||
        now - authIp.last_activity_at < 15_000 ||
        isResumeGraceAccess);
    const shouldCountDownload = !opts.isHead && !isRangeContinuation;

    if (shouldCountDownload && fresh.max_downloads !== null && fresh.download_count >= fresh.max_downloads) {
      return {
        allowed: false,
        status: 410,
        code: "max_downloads",
        message: "Download limit for this link has been reached",
        outcome: "denied_max_downloads",
      };
    }

    if (opts.isHead) {
      return { allowed: true, link: fresh, isResumeGraceAccess, countedDownload: false };
    }

    // Claim lock_to_first_ip atomically if unset
    if (fresh.lock_to_first_ip && !fresh.locked_ip) {
      db.prepare("UPDATE links SET locked_ip = ? WHERE id = ? AND locked_ip IS NULL").run(opts.ip, fresh.id);
    }

    // Record / refresh authorized IP
    if (authIp) {
      db.prepare(
        "UPDATE link_authorized_ips SET last_activity_at = ?, requests_count = requests_count + 1 WHERE link_id = ? AND ip = ?",
      ).run(now, fresh.id, opts.ip);
    } else {
      db.prepare(
        `INSERT INTO link_authorized_ips (link_id, ip, first_started_at, last_activity_at, requests_count, bytes_sent)
         VALUES (?, ?, ?, ?, 1, 0)`,
      ).run(fresh.id, opts.ip, now, now);
    }

    // Refresh sliding debounce expiry & activity timestamp
    let nextExpiresAt = fresh.expires_at;
    if (fresh.expiry_mode === "sliding" && fresh.idle_ttl_sec && !isResumeGraceAccess) {
      let candidate = now + fresh.idle_ttl_sec * 1000;
      if (fresh.hard_expires_at !== null && candidate > fresh.hard_expires_at) {
        candidate = fresh.hard_expires_at;
      }
      if (nextExpiresAt === null || candidate > nextExpiresAt) {
        nextExpiresAt = candidate;
      }
    }

    db.prepare(
      `UPDATE links
       SET download_count = download_count + ?,
           last_activity_at = ?,
           expires_at = ?
       WHERE id = ?`,
    ).run(shouldCountDownload ? 1 : 0, now, nextExpiresAt, fresh.id);

    const updated = db.query<LinkRow, [string]>("SELECT * FROM links WHERE id = ?").get(fresh.id)!;
    return {
      allowed: true,
      link: updated,
      isResumeGraceAccess,
      countedDownload: shouldCountDownload,
    };
  });
}

/**
 * Called every 30s while streaming and on stream close.
 * Keeps `last_activity_at`, `link_authorized_ips.last_activity_at`, `total_bytes_served`,
 * and sliding `expires_at` fresh so active multi-hour transfers never let the link expire
 * and reset the idle debounce clock when finished.
 */
export function refreshLinkActivity(linkId: string, ip: string, deltaBytes: number): void {
  const now = Date.now();
  const link = db.query<LinkRow, [string]>("SELECT * FROM links WHERE id = ?").get(linkId);
  if (!link) return;

  let nextExpiresAt = link.expires_at;
  if (link.expiry_mode === "sliding" && link.idle_ttl_sec && link.status === "active") {
    const hardPassed = link.hard_expires_at !== null && now >= link.hard_expires_at;
    if (!hardPassed) {
      let candidate = now + link.idle_ttl_sec * 1000;
      if (link.hard_expires_at !== null && candidate > link.hard_expires_at) {
        candidate = link.hard_expires_at;
      }
      if (nextExpiresAt === null || candidate > nextExpiresAt) {
        nextExpiresAt = candidate;
      }
    }
  }

  db.prepare(
    "UPDATE links SET last_activity_at = ?, total_bytes_served = total_bytes_served + ?, expires_at = ? WHERE id = ?",
  ).run(now, Math.max(0, deltaBytes), nextExpiresAt, linkId);

  db.prepare(
    "UPDATE link_authorized_ips SET last_activity_at = ?, bytes_sent = bytes_sent + ? WHERE link_id = ? AND ip = ?",
  ).run(now, Math.max(0, deltaBytes), linkId, ip);
}

const insertDownloadEventStmt = db.prepare(
  `INSERT INTO download_events (link_id, ts, ip, user_agent, method, range_start, range_end, bytes_sent, status, outcome, duration_ms)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
);

export function recordDownloadEvent(evt: {
  linkId: string;
  ip: string;
  userAgent: string;
  method: string;
  rangeStart?: number | null;
  rangeEnd?: number | null;
  bytesSent: number;
  status: number;
  outcome: string;
  durationMs: number;
}): void {
  insertDownloadEventStmt.run(
    evt.linkId,
    Date.now(),
    evt.ip,
    evt.userAgent.slice(0, 240),
    evt.method,
    evt.rangeStart ?? null,
    evt.rangeEnd ?? null,
    Math.max(0, evt.bytesSent),
    evt.status,
    evt.outcome,
    Math.max(0, Math.round(evt.durationMs)),
  );
}

// ===== Maintenance Sweeper =====

export function sweepMaintenance(now = Date.now()): { expiredLinks: number; deletedUploads: number } {
  // 1. Prune expired sessions and auth challenges
  db.prepare("DELETE FROM sessions WHERE abs_expires_at < ?").run(now);
  db.prepare("DELETE FROM auth_challenges WHERE expires_at < ?").run(now);

  // 2. Expire links whose primary deadline AND all active/resume-grace windows have ended
  const candidates = db
    .query<LinkRow, []>("SELECT * FROM links WHERE status = 'active'")
    .all();

  let expiredLinks = 0;
  for (const link of candidates) {
    const activeCount = activeCountForLink(link.id);
    if (activeCount > 0) continue;

    const authIps = db
      .query<LinkAuthorizedIpRow, [string]>("SELECT * FROM link_authorized_ips WHERE link_id = ?")
      .all(link.id);
    const state = computeEffectiveStatus(link, now, activeCount, authIps);
    if (state.effectiveStatus === "expired") {
      db.prepare("UPDATE links SET status = 'expired' WHERE id = ? AND status = 'active'").run(link.id);
      expiredLinks++;
    }
  }

  // 3. Auto-delete upload files when all links referencing them are expired/revoked and auto_delete_file = 1
  let deletedUploads = 0;
  const uploadRows = db
    .query<UploadRow, []>("SELECT * FROM uploads WHERE status = 'ready'")
    .all();
  for (const upload of uploadRows) {
    const linked = db
      .query<LinkRow, [string]>("SELECT * FROM links WHERE upload_id = ?")
      .all(upload.id);
    if (linked.length === 0) continue;
    const anyAutoDelete = linked.some((l) => l.auto_delete_file === 1);
    if (!anyAutoDelete) continue;
    const anyAlive = linked.some(
      (l) => l.status === "active" || l.status === "paused" || activeCountForLink(l.id) > 0,
    );
    if (anyAlive) continue;

    const absPath = resolveUploadPath(upload.stored_name);
    try {
      if (existsSync(absPath)) unlinkSync(absPath);
    } catch {}
    db.prepare("UPDATE uploads SET status = 'deleted' WHERE id = ?").run(upload.id);
    deletedUploads++;
  }

  // 4. Clean stale incomplete .part uploads older than 24h
  const staleCutoff = now - LIMITS.staleUploadMaxAgeMs;
  const staleUploads = db
    .query<UploadRow, [number]>("SELECT * FROM uploads WHERE status = 'uploading' AND created_at < ?")
    .all(staleCutoff);
  for (const stale of staleUploads) {
    const partPath = `${resolveUploadPath(stale.stored_name)}.part`;
    try {
      if (existsSync(partPath)) unlinkSync(partPath);
    } catch {}
    db.prepare("DELETE FROM uploads WHERE id = ?").run(stale.id);
  }

  return { expiredLinks, deletedUploads };
}

export function getEffectivePublicBaseUrl(req?: Request): string {
  const dbSetting = getSetting("base_url_override");
  return publicBaseUrlFor(req, dbSetting);
}
