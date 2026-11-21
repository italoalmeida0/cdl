import { createSignal } from "solid-js";

function readMetaBasePath(): string {
  if (typeof document === "undefined") return "";
  const raw = document.querySelector('meta[name="cdl-base"]')?.getAttribute("content")?.trim() ?? "";
  if (!raw || raw === "{{BASE}}") return "";
  return raw.replace(/\/+$/, "");
}

export const BASE_PATH = readMetaBasePath();

export function withBase(path: string): string {
  const normalized = path.startsWith("/") ? path : `/${path}`;
  return `${BASE_PATH}${normalized}`;
}

export interface AdminProfile {
  username: string;
  totpEnabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface Session {
  accessToken: string;
  refreshToken: string;
  admin: AdminProfile;
}

export interface MountStatusDto {
  path: string;
  available: boolean;
  readable: boolean;
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

export interface UploadDto {
  id: string;
  originalName: string;
  storedName: string;
  sizeBytes: number;
  receivedBytes: number;
  mimeType: string;
  sha256: string | null;
  status: "uploading" | "ready" | "deleted";
  existsOnDisk: boolean;
  activeLinksCount: number;
  createdAt: number;
  completedAt: number | null;
}

export type ExpiryMode = "sliding" | "fixed" | "never";
export type EffectiveLinkStatus = "active" | "resume_only" | "paused" | "expired" | "revoked";

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
  status: "active" | "paused" | "revoked" | "expired";
  effectiveStatus: EffectiveLinkStatus;
  resumeUntil: number | null;
  activeTransfersCount: number;
  activeBytesPerSec: number;
  authorizedIpsCount: number;
  createdAt: number;
  lastActivityAt: number | null;
}

export interface LinkAuthorizedIpDto {
  ip: string;
  firstStartedAt: number;
  lastActivityAt: number;
  requestsCount: number;
  bytesSent: number;
}

export interface DownloadEventDto {
  id: number;
  linkId: string;
  label?: string;
  filename?: string;
  token?: string;
  ts: number;
  ip: string;
  userAgent: string;
  method: string;
  rangeStart: number | null;
  rangeEnd: number | null;
  bytesSent: number;
  status: number;
  outcome: string;
  durationMs: number;
}

export interface LiveTransferDto {
  id: string;
  linkId: string;
  token: string;
  filename: string;
  ip: string;
  userAgent: string;
  startedAt: number;
  lastProgressAt: number;
  rangeStart: number;
  rangeEnd: number;
  totalRangeBytes: number;
  fileSize: number;
  bytesSent: number;
  bytesPerSec: number;
  progressPct: number;
}

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

export interface SettingsDto {
  clientIp: string;
  envBaseUrlLocked: boolean;
  envBaseUrl: string;
  baseUrlOverride: string;
  effectiveBaseUrl: string;
  effectiveBasePath: string;
  trustProxy: boolean;
  filesDir: string;
  mount: MountStatusDto;
  chunkMaxBytes: number;
  defaultPolicy: LinkPolicyDefaults;
}

const LS_KEY = "cdl_session";

function loadStored(): Session | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(LS_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

const [session, setSessionSignal] = createSignal<Session | null>(loadStored());

export function currentSession(): Session | null {
  return session();
}

function latestSession(): Session | null {
  const stored = loadStored();
  const cur = session();
  if (stored && (!cur || stored.refreshToken !== cur.refreshToken)) {
    setSessionSignal(stored);
  }
  if (!stored && cur) setSessionSignal(null);
  return stored ?? null;
}

export function setSession(s: Session | null): void {
  if (typeof localStorage !== "undefined") {
    if (s) localStorage.setItem(LS_KEY, JSON.stringify(s));
    else localStorage.removeItem(LS_KEY);
  }
  setSessionSignal(s);
}

export function authHeaders(): Record<string, string> {
  const s = latestSession();
  return s ? { Authorization: `Bearer ${s.accessToken}` } : {};
}

export class ApiFail extends Error {
  status: number;
  code?: string;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

let refreshPromise: Promise<boolean> | null = null;

async function refresh(): Promise<boolean> {
  const s = latestSession();
  if (!s) return false;
  try {
    const res = await fetch(withBase("/api/auth/refresh"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken: s.refreshToken }),
    });
    const j = await res.json();
    if (!res.ok || !j.success) return false;
    setSession({
      accessToken: j.accessToken,
      refreshToken: j.refreshToken,
      admin: j.admin,
    });
    return true;
  } catch {
    return false;
  }
}

async function refreshSingleFlight(): Promise<boolean> {
  if (!refreshPromise) {
    refreshPromise = refresh().finally(() => {
      refreshPromise = null;
    });
  }
  return refreshPromise;
}

async function rawCall<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const headers: Record<string, string> = { ...authHeaders() };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(withBase(path), {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal,
  });
  let j: any = null;
  try {
    j = await res.json();
  } catch {}
  signal?.throwIfAborted();
  if (!res.ok) throw new ApiFail(res.status, j?.error ?? `HTTP ${res.status}`, j?.code);
  return j as T;
}

export async function api<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  try {
    return await rawCall<T>(method, path, body, signal);
  } catch (e) {
    if (e instanceof ApiFail && e.status === 401 && latestSession()) {
      const ok = await refreshSingleFlight();
      if (ok) {
        return await rawCall<T>(method, path, body, signal);
      }
      setSession(null);
      if (typeof location !== "undefined") location.hash = "#/login";
    }
    throw e;
  }
}

export async function publicApi<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(withBase(path), {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let j: any = null;
  try {
    j = await res.json();
  } catch {}
  if (!res.ok) throw new ApiFail(res.status, j?.error ?? `HTTP ${res.status}`, j?.code);
  return j as T;
}

export interface UploadProgress {
  loaded: number;
  total: number;
  pct: number;
  bytesPerSec: number;
  etaSec: number | null;
}

export async function uploadFileChunked(
  file: File,
  opts: { onProgress?: (p: UploadProgress) => void; signal?: AbortSignal } = {},
): Promise<UploadDto> {
  const initRes = await api<{ upload: UploadDto; chunkMaxBytes: number }>(
    "POST",
    "/api/uploads/init",
    { filename: file.name, sizeBytes: file.size },
    opts.signal,
  );

  const upload = initRes.upload;
  const chunkSize = Math.min(8 * 1024 * 1024, initRes.chunkMaxBytes || 8 * 1024 * 1024);
  const startedAt = Date.now();
  let offset = 0;

  while (offset < file.size) {
    opts.signal?.throwIfAborted();
    const end = Math.min(file.size, offset + chunkSize);
    const slice = file.slice(offset, end);

    let attempt = 0;
    while (true) {
      try {
        let res = await fetch(withBase(`/api/uploads/${upload.id}/chunk?offset=${offset}`), {
          method: "PUT",
          headers: { ...authHeaders(), "Content-Type": "application/octet-stream" },
          body: slice,
          signal: opts.signal,
        });
        if (res.status === 401 && (await refreshSingleFlight())) {
          res = await fetch(withBase(`/api/uploads/${upload.id}/chunk?offset=${offset}`), {
            method: "PUT",
            headers: { ...authHeaders(), "Content-Type": "application/octet-stream" },
            body: slice,
            signal: opts.signal,
          });
        }
        if (!res.ok) {
          let errMsg = `Chunk failed (HTTP ${res.status})`;
          try {
            const j = await res.json();
            if (j?.error) errMsg = j.error;
          } catch {}
          throw new ApiFail(res.status, errMsg);
        }
        break;
      } catch (e) {
        if (opts.signal?.aborted) throw e;
        attempt++;
        if (attempt >= 3) throw e;
        await new Promise((r) => setTimeout(r, 400 * attempt));
      }
    }

    offset = end;
    const elapsedSec = Math.max(0.05, (Date.now() - startedAt) / 1000);
    const bytesPerSec = Math.round(offset / elapsedSec);
    const remaining = file.size - offset;
    opts.onProgress?.({
      loaded: offset,
      total: file.size,
      pct: file.size > 0 ? Math.min(100, Math.round((offset / file.size) * 1000) / 10) : 100,
      bytesPerSec,
      etaSec: bytesPerSec > 0 ? Math.ceil(remaining / bytesPerSec) : null,
    });
  }

  const completeRes = await api<{ upload: UploadDto }>(
    "POST",
    `/api/uploads/${upload.id}/complete`,
    {},
    opts.signal,
  );
  return completeRes.upload;
}
