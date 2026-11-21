import { BlockList, isIP } from "node:net";
import {
  ALLOWED_ORIGINS,
  BASE_PATH,
  PUBLIC_BASE_URL,
  TRUSTED_PROXY_CIDRS,
  TRUST_PROXY,
  parseBaseUrl,
} from "./config";

/**
 * Shared HTTP utilities: security headers, CORS, client-IP resolution,
 * IP/CIDR whitelist matching, body validation, Content-Disposition encoding,
 * and JSON response helpers.
 */

export class ApiError extends Error {
  status: number;
  code?: string;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function hasControlCharacters(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

function corsOriginFor(req?: Request): string | null {
  if (!req || ALLOWED_ORIGINS.length === 0) return null;
  const origin = req.headers.get("origin");
  if (!origin) return null;
  return ALLOWED_ORIGINS.includes(origin) ? origin : null;
}

export function baseHeaders(req?: Request, cspPolicy?: string): Headers {
  const h = new Headers();
  h.set("X-Content-Type-Options", "nosniff");
  h.set("X-Frame-Options", "DENY");
  h.set("Referrer-Policy", "strict-origin-when-cross-origin");
  h.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  if (cspPolicy) {
    h.set("Content-Security-Policy", cspPolicy);
  }
  const cors = corsOriginFor(req);
  if (cors) {
    h.set("Access-Control-Allow-Origin", cors);
    h.set("Vary", "Origin");
    h.set("Access-Control-Allow-Methods", "GET, POST, PATCH, PUT, DELETE, OPTIONS");
    h.set("Access-Control-Allow-Headers", "Content-Type, Authorization, X-CDL-Password");
    h.set("Access-Control-Expose-Headers", "Retry-After, Content-Disposition, Content-Range, X-Checksum-SHA256");
    h.set("Access-Control-Max-Age", "600");
  }
  return h;
}

export function json(data: unknown, init: { status?: number; req?: Request } = {}): Response {
  const h = baseHeaders(init.req);
  h.set("Content-Type", "application/json; charset=utf-8");
  h.set("Cache-Control", "no-store");
  return new Response(JSON.stringify(data), { status: init.status ?? 200, headers: h });
}

export function ok(data: Record<string, unknown> = {}, req?: Request): Response {
  return json({ success: true, ...data }, { req });
}

export function err(status: number, message: string, req?: Request, code?: string): Response {
  return json({ success: false, error: message, ...(code ? { code } : {}) }, { status, req });
}

export function rateLimitError(message: string, retryAfter: number, req?: Request): Response {
  const res = err(429, message, req, "rate_limited");
  res.headers.set("Retry-After", String(Math.max(1, Math.ceil(retryAfter))));
  return res;
}

// ===== IP Canonicalization & Trusted Proxy Resolution =====

type PeerServer = { requestIP(req: Request): { address: string } | null };

const trustedProxies = new BlockList();
for (const entry of TRUSTED_PROXY_CIDRS) {
  const pieces = entry.split("/");
  const address = pieces[0]!;
  const version = isIP(address);
  const prefix = pieces.length === 1 ? (version === 4 ? 32 : 128) : /^\d+$/.test(pieces[1]!) ? Number(pieces[1]) : NaN;
  if (!version || pieces.length > 2 || !Number.isInteger(prefix) || prefix < 0 || prefix > (version === 4 ? 32 : 128)) {
    throw new Error(`Invalid TRUSTED_PROXY_CIDRS entry: ${entry}`);
  }
  trustedProxies.addSubnet(address, prefix, version === 4 ? "ipv4" : "ipv6");
}

const requestIps = new WeakMap<Request, string>();

export function canonicalIp(value: string): string | null {
  let address = value.trim();
  if (!address) return null;
  // Strip IPv6 zone ID if present (e.g., fe80::1%eth0)
  const zoneIdx = address.indexOf("%");
  if (zoneIdx !== -1) address = address.slice(0, zoneIdx);
  // Handle IPv4 with port (e.g. 1.2.3.4:5678)
  if (/^\d{1,3}(?:\.\d{1,3}){3}:\d+$/.test(address)) {
    address = address.slice(0, address.lastIndexOf(":"));
  }
  const version = isIP(address);
  if (version === 4) return address;
  if (version !== 6) return null;
  let normalized: string;
  try {
    normalized = new URL(`http://[${address}]/`).hostname.slice(1, -1);
  } catch {
    return null;
  }
  const mapped = normalized.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (!mapped) return normalized;
  const high = parseInt(mapped[1]!, 16);
  const low = parseInt(mapped[2]!, 16);
  return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
}

function isTrustedProxyIp(address: string): boolean {
  const normalized = canonicalIp(address);
  if (!normalized) return false;
  const version = isIP(normalized);
  if (!version) return false;
  return trustedProxies.check(normalized, version === 4 ? "ipv4" : "ipv6");
}

export function clientIp(req: Request, server?: PeerServer): string {
  const cached = requestIps.get(req);
  if (cached) return cached;
  if (!server) return "unknown";

  const peer = canonicalIp(server.requestIP(req)?.address ?? "") ?? "unknown";
  let result = peer;
  if (TRUST_PROXY && isTrustedProxyIp(peer)) {
    const cf = req.headers.get("cf-connecting-ip") || req.headers.get("true-client-ip");
    const cfIp = cf ? canonicalIp(cf) : null;
    if (cfIp) {
      result = cfIp;
    } else {
      const xff = req.headers.get("x-forwarded-for");
      if (xff) {
        const parts = xff.split(",");
        const chain = parts.length <= 32 ? parts.map(canonicalIp) : [];
        if (chain.length > 0 && chain.every((ip) => ip !== null)) {
          for (let i = chain.length - 1; i >= 0 && isTrustedProxyIp(result); i--) {
            result = chain[i]!;
          }
        }
      } else {
        const realIp = req.headers.get("x-real-ip");
        if (realIp) result = canonicalIp(realIp) ?? peer;
      }
    }
  }
  requestIps.set(req, result);
  return result;
}

// ===== IP Whitelist Parsing & Matching =====

export function parseIpWhitelist(input: unknown): string[] {
  if (input === undefined || input === null || input === "") return [];
  const rawItems: string[] = Array.isArray(input)
    ? input.map((v) => String(v))
    : typeof input === "string"
      ? input.split(/[\s,;]+/)
      : (() => {
          throw new ApiError(400, "ipWhitelist must be an array of IP/CIDR strings");
        })();

  const cleaned: string[] = [];
  const seen = new Set<string>();
  for (const item of rawItems) {
    const trimmed = item.trim();
    if (!trimmed) continue;
    const parts = trimmed.split("/");
    if (parts.length > 2) {
      throw new ApiError(400, `Invalid IP/CIDR entry: ${trimmed}`);
    }
    const canon = canonicalIp(parts[0]!);
    if (!canon) {
      throw new ApiError(400, `Invalid IP address: ${trimmed}`);
    }
    const ver = isIP(canon);
    if (parts.length === 2) {
      if (!/^\d+$/.test(parts[1]!)) {
        throw new ApiError(400, `Invalid CIDR prefix: ${trimmed}`);
      }
      const prefix = Number(parts[1]);
      const maxPrefix = ver === 4 ? 32 : 128;
      if (!Number.isInteger(prefix) || prefix < 0 || prefix > maxPrefix) {
        throw new ApiError(400, `Invalid CIDR prefix range: ${trimmed}`);
      }
      const normEntry = `${canon}/${prefix}`;
      if (!seen.has(normEntry)) {
        seen.add(normEntry);
        cleaned.push(normEntry);
      }
    } else {
      if (!seen.has(canon)) {
        seen.add(canon);
        cleaned.push(canon);
      }
    }
  }
  if (cleaned.length > 256) {
    throw new ApiError(400, "ipWhitelist cannot exceed 256 entries");
  }
  return cleaned;
}

export function ipMatchesWhitelist(ip: string, whitelist: string[]): boolean {
  if (whitelist.length === 0) return true;
  const canon = canonicalIp(ip);
  if (!canon) return false;
  const version = isIP(canon);
  if (!version) return false;

  const list = new BlockList();
  for (const entry of whitelist) {
    const [addrPart, prefixPart] = entry.split("/");
    const entryIp = canonicalIp(addrPart ?? "");
    if (!entryIp) continue;
    const entryVer = isIP(entryIp);
    if (!entryVer) continue;
    if (prefixPart !== undefined) {
      const prefix = Number(prefixPart);
      list.addSubnet(entryIp, prefix, entryVer === 4 ? "ipv4" : "ipv6");
    } else {
      list.addAddress(entryIp, entryVer === 4 ? "ipv4" : "ipv6");
    }
  }
  return list.check(canon, version === 4 ? "ipv4" : "ipv6");
}

// ===== Public Base URL resolution =====

export function publicBaseUrlFor(req?: Request, configuredDbBaseUrl?: string | null): string {
  if (PUBLIC_BASE_URL) {
    if (PUBLIC_BASE_URL.startsWith("http://") || PUBLIC_BASE_URL.startsWith("https://")) {
      return PUBLIC_BASE_URL;
    }
  }
  const dbParsed = configuredDbBaseUrl ? parseBaseUrl(configuredDbBaseUrl) : null;
  if (dbParsed && dbParsed.publicBaseUrl && (dbParsed.origin || !PUBLIC_BASE_URL)) {
    if (dbParsed.origin) return `${dbParsed.origin}${BASE_PATH || dbParsed.basePath}`;
  }
  if (req) {
    const reqUrl = new URL(req.url);
    const proto = TRUST_PROXY
      ? (req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() || reqUrl.protocol.replace(":", ""))
      : reqUrl.protocol.replace(":", "");
    const host = TRUST_PROXY
      ? (req.headers.get("x-forwarded-host")?.split(",")[0]?.trim() || req.headers.get("host") || reqUrl.host)
      : (req.headers.get("host") || reqUrl.host);
    const activeBasePath = BASE_PATH || dbParsed?.basePath || "";
    return `${proto}://${host}${activeBasePath}`;
  }
  return PUBLIC_BASE_URL || "";
}

// ===== Content-Disposition RFC 5987 =====

export function encodeContentDisposition(filename: string, disposition: "attachment" | "inline" = "attachment"): string {
  const safeAscii = filename
    .replace(/[\r\n\0"\\]/g, "_")
    .replace(/[^\x20-\x7e]/g, "_")
    .trim() || "download";
  const encodedUtf8 = encodeURIComponent(filename)
    .replace(/['()*!]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${disposition}; filename="${safeAscii}"; filename*=UTF-8''${encodedUtf8}`;
}

// ===== Body parsing & validation =====

export async function readJsonBody(req: Request, maxBytes: number): Promise<Record<string, unknown>> {
  const cl = req.headers.get("content-length");
  if (cl && Number(cl) > maxBytes) throw new ApiError(413, "payload too large");

  const ctype = req.headers.get("content-type") || "";
  if (!ctype.toLowerCase().includes("application/json")) {
    throw new ApiError(415, "content-type must be application/json");
  }

  const buf = await req.arrayBuffer();
  if (buf.byteLength > maxBytes) throw new ApiError(413, "payload too large");

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(buf));
  } catch {
    throw new ApiError(400, "invalid JSON body");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ApiError(400, "JSON body must be an object");
  }
  return parsed as Record<string, unknown>;
}

export const v = {
  str(body: Record<string, unknown>, key: string, opts: { min?: number; max?: number; optional?: boolean } = {}): string | null {
    const val = body[key];
    if (val === undefined || val === null || val === "") {
      if (opts.optional) return null;
      throw new ApiError(400, `${key} is required`);
    }
    if (typeof val !== "string") throw new ApiError(400, `${key} must be a string`);
    const min = opts.min ?? 0;
    const max = opts.max ?? 1024;
    if (val.length < min) throw new ApiError(400, `${key} is too short`);
    if (val.length > max) throw new ApiError(400, `${key} is too long`);
    return val;
  },

  int(body: Record<string, unknown>, key: string, opts: { min?: number; max?: number; optional?: boolean } = {}): number | null {
    const val = body[key];
    if (val === undefined || val === null || val === "") {
      if (opts.optional) return null;
      throw new ApiError(400, `${key} is required`);
    }
    const n = typeof val === "string" && /^-?\d+$/.test(val) ? Number(val) : val;
    if (typeof n !== "number" || !Number.isInteger(n)) throw new ApiError(400, `${key} must be an integer`);
    if (opts.min !== undefined && n < opts.min) throw new ApiError(400, `${key} is too small`);
    if (opts.max !== undefined && n > opts.max) throw new ApiError(400, `${key} is too large`);
    return n;
  },

  bool(body: Record<string, unknown>, key: string, fallback?: boolean): boolean {
    const val = body[key];
    if (val === undefined || val === null) {
      if (fallback !== undefined) return fallback;
      throw new ApiError(400, `${key} is required`);
    }
    if (typeof val !== "boolean") throw new ApiError(400, `${key} must be a boolean`);
    return val;
  },
};
