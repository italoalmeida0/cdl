import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { brotliCompressSync, constants as zlibConstants, gzipSync } from "node:zlib";

const COMPRESSIBLE = new Set([
  ".js", ".mjs", ".css", ".html", ".json", ".svg", ".txt", ".webmanifest", ".wasm", ".xml",
]);

const MIN_BYTES = 1024;
const MAX_CACHE_BYTES = 32 * 1024 * 1024;

export type Encoding = "br" | "gzip";

interface CacheEntry {
  bytes: Uint8Array;
  size: number;
  mtimeMs: number;
}

const cache = new Map<string, CacheEntry>();
let cacheBytes = 0;

export function isCompressible(extension: string): boolean {
  return COMPRESSIBLE.has(extension.toLowerCase());
}

export function negotiateEncoding(acceptEncoding: string | null): Encoding | null {
  if (!acceptEncoding) return null;
  const accepted: Array<{ token: string; q: number }> = [];
  for (const part of acceptEncoding.split(",")) {
    const [rawToken, ...params] = part.trim().toLowerCase().split(";");
    const token = rawToken?.trim();
    if (!token) continue;
    let q = 1;
    for (const param of params) {
      const match = /^\s*q\s*=\s*([0-9.]+)\s*$/.exec(param);
      if (match) {
        const parsed = Number(match[1]);
        q = Number.isFinite(parsed) ? Math.min(1, Math.max(0, parsed)) : 0;
      }
    }
    accepted.push({ token, q });
  }
  if (accepted.length === 0) return null;
  const qOf = (token: string) => {
    const exact = accepted.find((e) => e.token === token);
    if (exact) return exact.q;
    const wildcard = accepted.find((e) => e.token === "*");
    return wildcard ? wildcard.q : 0;
  };
  const br = qOf("br");
  const gzip = qOf("gzip");
  const best = Math.max(br, gzip);
  if (best <= 0) return null;
  const explicitIdentity = accepted.find((e) => e.token === "identity");
  if (explicitIdentity && explicitIdentity.q > best) return null;
  return br >= gzip ? "br" : "gzip";
}

function compress(data: Uint8Array, encoding: Encoding): Uint8Array {
  return encoding === "br"
    ? new Uint8Array(
        brotliCompressSync(new Uint8Array(data), {
          params: {
            [zlibConstants.BROTLI_PARAM_QUALITY]: data.length > 512 * 1024 ? 8 : 11,
            [zlibConstants.BROTLI_PARAM_SIZE_HINT]: data.length,
          },
        }),
      )
    : new Uint8Array(gzipSync(new Uint8Array(data), { level: 9 }));
}

function remember(key: string, entry: CacheEntry): void {
  cache.set(key, entry);
  cacheBytes += entry.bytes.length;
  while (cacheBytes > MAX_CACHE_BYTES && cache.size > 1) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    const evicted = cache.get(oldest.value);
    cache.delete(oldest.value);
    if (evicted) cacheBytes -= evicted.bytes.length;
  }
}

export function compressedAsset(filePath: string, encoding: Encoding): Uint8Array | null {
  if (!isCompressible(path.extname(filePath))) return null;
  let stats;
  try {
    stats = statSync(filePath);
  } catch {
    return null;
  }
  if (!stats.isFile() || stats.size < MIN_BYTES) return null;
  const key = `${encoding}:${filePath}`;
  const hit = cache.get(key);
  if (hit && hit.size === stats.size && hit.mtimeMs === stats.mtimeMs) {
    cache.delete(key);
    cache.set(key, hit);
    return hit.bytes;
  }
  let raw: Uint8Array;
  try {
    raw = new Uint8Array(readFileSync(filePath));
  } catch {
    return null;
  }
  const bytes = compress(raw, encoding);
  if (bytes.length >= raw.length) return null;
  remember(key, { bytes, size: stats.size, mtimeMs: stats.mtimeMs });
  return bytes;
}
