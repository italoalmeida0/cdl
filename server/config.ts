import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import path from "path";

export interface ParsedBaseUrl {
  raw: string;
  origin: string;
  basePath: string;
  publicBaseUrl: string;
}

/**
 * Normalize BASE_URL / PUBLIC_URL into origin + subpath.
 * Examples:
 *   "https://example.com/lalala/" -> origin="https://example.com", basePath="/lalala", publicBaseUrl="https://example.com/lalala"
 *   "https://example.com"         -> origin="https://example.com", basePath="", publicBaseUrl="https://example.com"
 *   "/lalala/"                    -> origin="", basePath="/lalala", publicBaseUrl="/lalala"
 *   ""                            -> origin="", basePath="", publicBaseUrl=""
 */
export function parseBaseUrl(rawInput: string | undefined | null): ParsedBaseUrl {
  const trimmed = (rawInput ?? "").trim();
  if (!trimmed) {
    return { raw: "", origin: "", basePath: "", publicBaseUrl: "" };
  }

  let origin = "";
  let rawPath = "";

  if (/^https?:\/\//i.test(trimmed)) {
    const parsed = new URL(trimmed);
    origin = parsed.origin;
    rawPath = parsed.pathname;
  } else if (trimmed.startsWith("/")) {
    rawPath = trimmed.split(/[?#]/)[0] ?? "";
  } else if (trimmed.includes(".")) {
    const parsed = new URL(`https://${trimmed}`);
    origin = parsed.origin;
    rawPath = parsed.pathname;
  } else {
    rawPath = `/${trimmed.split(/[?#]/)[0] ?? ""}`;
  }

  // Collapse duplicate slashes and remove trailing slash.
  const collapsed = rawPath.replace(/\/+/g, "/").replace(/\/+$/, "");
  const basePath = collapsed === "/" ? "" : collapsed;
  const publicBaseUrl = origin ? `${origin}${basePath}` : basePath;
  return { raw: trimmed, origin, basePath, publicBaseUrl };
}

export const NODE_ENV = process.env.NODE_ENV || "production";
export const IS_PROD = NODE_ENV === "production";
export const PORT = Number(process.env.PORT || 3000);
export const HOST = process.env.HOST || "0.0.0.0";

export const DATA_DIR = path.resolve(
  process.env.DATA_DIR || path.join(import.meta.dir, "..", "data"),
);
export const FILES_DIR = path.resolve(
  process.env.FILES_DIR || path.join(import.meta.dir, "..", "files"),
);
export const UPLOADS_DIR = path.resolve(
  process.env.UPLOADS_DIR || path.join(DATA_DIR, "uploads"),
);

const envBaseRaw = (process.env.BASE_URL ?? process.env.PUBLIC_URL ?? "").trim();
export const ENV_BASE_URL_SET = envBaseRaw.length > 0;
export const PARSED_ENV_BASE = parseBaseUrl(envBaseRaw);
export const BASE_PATH = PARSED_ENV_BASE.basePath;
export const PUBLIC_BASE_URL = PARSED_ENV_BASE.publicBaseUrl;

export const ADMIN_USERNAME = (process.env.ADMIN_USERNAME || "admin").trim() || "admin";
export const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";

export const TRUST_PROXY = process.env.TRUST_PROXY === "true";
const defaultProxyCidrs = "127.0.0.1/8,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,::1/128";
export const TRUSTED_PROXY_CIDRS = (
  process.env.TRUSTED_PROXY_CIDRS !== undefined
    ? process.env.TRUSTED_PROXY_CIDRS
    : TRUST_PROXY
      ? defaultProxyCidrs
      : ""
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

export const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

export const UPLOAD_CHUNK_MAX_BYTES = positiveInt(
  "UPLOAD_CHUNK_MAX_BYTES",
  32 * 1024 * 1024,
);

function positiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return n;
}

function loadSecret(): string {
  const envSecret = process.env.CDL_SECRET || "";
  if (envSecret) {
    if (envSecret.length < 32) {
      throw new Error("CDL_SECRET must be at least 32 characters long");
    }
    return envSecret;
  }

  const secretFileEnv = process.env.CDL_SECRET_FILE;
  if (secretFileEnv) {
    const content = readFileSync(secretFileEnv, "utf8").trim();
    if (content.length < 32) {
      throw new Error("CDL_SECRET_FILE content must be at least 32 characters long");
    }
    return content;
  }

  mkdirSync(DATA_DIR, { recursive: true });
  const persistedPath = path.join(DATA_DIR, ".secret");
  if (existsSync(persistedPath)) {
    const existing = readFileSync(persistedPath, "utf8").trim();
    if (existing.length >= 32) return existing;
  }

  const generated = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
  writeFileSync(persistedPath, generated, "utf8");
  try {
    chmodSync(persistedPath, 0o600);
  } catch {}
  return generated;
}

export const CDL_SECRET = loadSecret();

export const LIMITS = {
  sqliteBusyTimeoutMs: positiveInt("SQLITE_BUSY_TIMEOUT_MS", 50),
  apiBodyBytes: positiveInt("LIMIT_API_BODY_BYTES", 256 * 1024),
  authBodyBytes: positiveInt("LIMIT_AUTH_BODY_BYTES", 16 * 1024),
  ipPerMin: positiveInt("LIMIT_IP_PER_MIN", 60_000),
  authPerMinPerIp: positiveInt("LIMIT_AUTH_PER_MIN", 60),
  downloadFailPerMinPerIp: positiveInt("LIMIT_DOWNLOAD_FAIL_PER_MIN", 60),
  loginFailWindowMs: 15 * 60 * 1000,
  loginFailMax: 10,
  loginLockoutMs: 15 * 60 * 1000,
  linkFailWindowMs: 10 * 60 * 1000,
  linkFailMax: 20,
  linkLockoutMs: 5 * 60 * 1000,
  accessTokenTtlSec: 12 * 3600,
  refreshTokenTtlMs: 30 * 24 * 3600 * 1000,
  refreshAbsoluteTtlMs: 180 * 24 * 3600 * 1000,
  twoFaTempTtlSec: 5 * 60,
  staleUploadMaxAgeMs: 24 * 3600 * 1000,
  sweepIntervalMs: 60 * 1000,
  walCheckpointIntervalMs: 5 * 60 * 1000,
  defaultSlidingTtlSec: 3 * 3600,
  defaultResumeGraceSec: 3 * 3600,
  streamChunkBytes: 512 * 1024,
  heartbeatIntervalMs: 30_000,
};
