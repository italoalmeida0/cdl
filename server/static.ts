import { existsSync, readFileSync, statSync } from "fs";
import path from "path";

import { compressedAsset, negotiateEncoding } from "./compression";
import { BASE_PATH, parseBaseUrl } from "./config";
import { getSetting } from "./db";
import { baseHeaders } from "./http";

const DEFAULT_STATIC_ROOT = path.resolve(import.meta.dir, "..", "dist");

function currentStaticRoot(explicitRoot?: string): string {
  if (explicitRoot) return path.resolve(explicitRoot);
  return process.env.STATIC_DIR ? path.resolve(process.env.STATIC_DIR) : DEFAULT_STATIC_ROOT;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json",
};

const IMMUTABLE_EXT = new Set([".js", ".css", ".woff", ".woff2", ".png", ".jpg", ".webp", ".svg", ".ico"]);

function resolveStaticFile(urlPath: string, staticRoot?: string): { filePath: string; isHtml: boolean } | null {
  const root = currentStaticRoot(staticRoot);
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decoded.includes("\0")) return null;

  const stripped = decoded.replace(/^\/+/, "");
  const normalized = path.normalize(stripped);
  if (normalized.startsWith("..") || path.isAbsolute(normalized)) return null;
  const fullPath = path.join(root, normalized);
  if (!fullPath.startsWith(root + path.sep) && fullPath !== root) return null;

  const segments = normalized.split(path.sep);
  if (segments.some((s) => s.startsWith("."))) return null;
  if (normalized.endsWith(".map")) return null;

  let finalPath = fullPath;
  if (!existsSync(finalPath) || statSync(finalPath).isDirectory()) {
    if (path.extname(normalized) === "") {
      const indexPath = path.join(root, "index.html");
      if (!existsSync(indexPath)) return null;
      finalPath = indexPath;
    } else {
      return null;
    }
  }

  return { filePath: finalPath, isHtml: finalPath.endsWith(".html") };
}

function assetEtag(stats: { size: number; mtimeMs: number }): string {
  return `W/"${stats.size.toString(16)}-${Math.floor(stats.mtimeMs).toString(16)}"`;
}

function computeInlineScriptHashes(html: string): string[] {
  const hashes: string[] = [];
  const regex = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
  for (const match of html.matchAll(regex)) {
    const body = match[1] ?? "";
    if (!body.trim()) continue;
    const digest = new Bun.CryptoHasher("sha256").update(body).digest("base64");
    hashes.push(`'sha256-${digest}'`);
  }
  return hashes;
}

function activeBasePath(): string {
  if (BASE_PATH) return BASE_PATH;
  const override = getSetting("base_url_override");
  if (override) return parseBaseUrl(override).basePath;
  return "";
}

function buildHtmlCsp(scriptHashes: string[]): string {
  return [
    "default-src 'self'",
    `script-src 'self' ${scriptHashes.join(" ")}`.trim(),
    "connect-src 'self'",
    "img-src 'self' data: blob:",
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self' data:",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

export function serveStatic(req: Request, urlPath: string, staticRoot?: string): Response | null {
  const root = currentStaticRoot(staticRoot);
  if (!existsSync(root)) return null;
  const resolved = resolveStaticFile(urlPath === "/" ? "/index.html" : urlPath, root);
  if (!resolved) return null;

  if (resolved.isHtml) {
    const rawHtml = readFileSync(resolved.filePath, "utf8");
    const base = activeBasePath();
    const html = rawHtml.replaceAll("{{BASE}}", base);
    const scriptHashes = computeInlineScriptHashes(html);
    const headers = baseHeaders(req, buildHtmlCsp(scriptHashes));
    headers.set("Content-Type", "text/html; charset=utf-8");
    headers.set("Cache-Control", "no-cache");
    return new Response(req.method === "HEAD" ? null : html, { status: 200, headers });
  }

  const file = Bun.file(resolved.filePath);
  if (file.size === 0) return null;

  let stats: { size: number; mtimeMs: number } | null = null;
  try {
    const raw = statSync(resolved.filePath);
    stats = { size: raw.size, mtimeMs: raw.mtimeMs };
  } catch {
    stats = null;
  }

  const headers = baseHeaders(req);
  headers.set("Content-Type", MIME[path.extname(resolved.filePath).toLowerCase()] ?? "application/octet-stream");
  const immutable = IMMUTABLE_EXT.has(path.extname(resolved.filePath));
  headers.set("Cache-Control", immutable ? "public, max-age=31536000, immutable" : "public, max-age=300");
  headers.set("Vary", "Accept-Encoding");
  if (stats) headers.set("ETag", assetEtag(stats));

  if (stats) {
    const ifNoneMatch = req.headers.get("if-none-match");
    if (ifNoneMatch && ifNoneMatch.split(",").some((tag) => tag.trim() === assetEtag(stats!))) {
      return new Response(null, { status: 304, headers });
    }
  }

  if (!req.headers.get("range")) {
    const encoding = negotiateEncoding(req.headers.get("accept-encoding"));
    if (encoding) {
      const body = compressedAsset(resolved.filePath, encoding);
      if (body) {
        headers.set("Content-Encoding", encoding);
        headers.set("Content-Length", String(body.length));
        return new Response(req.method === "HEAD" ? null : (body as unknown as BodyInit), { status: 200, headers });
      }
    }
  }

  return new Response(req.method === "HEAD" ? null : file, { status: 200, headers });
}
