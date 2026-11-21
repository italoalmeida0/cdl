/**
 * Frontend dev server: serves web/index.html via Bun's HTML bundle plugins
 * and proxies /api/* and /d/* to the backend server (default http://localhost:3000).
 */
import { serve } from "bun";
import { existsSync } from "fs";
import path from "path";

import app from "./web/index.html";

const port = Number(Bun.argv[2] || 5700);
const API = process.env.CDL_API || "http://localhost:3000";
const DEV_ROOT = path.resolve(import.meta.dir);

function resolvePublicFile(urlPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decoded.includes("\0")) return null;
  const normalized = path.normalize(decoded.replace(/^\/+/, ""));
  if (!normalized || normalized.startsWith("..") || path.isAbsolute(normalized)) return null;
  if (normalized.split(path.sep).some((s) => s.startsWith("."))) return null;
  const pubRoot = path.join(DEV_ROOT, "web", "public");
  const full = path.join(pubRoot, normalized);
  if (!full.startsWith(pubRoot + path.sep)) return null;
  return existsSync(full) ? full : null;
}

const server = serve({
  routes: { "/": app },
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/d/")) {
      const upstream = new URL(url.pathname + url.search, API);
      const headers = new Headers(req.headers);
      headers.delete("host");
      try {
        return await fetch(upstream, {
          method: req.method,
          headers,
          body: req.method === "GET" || req.method === "HEAD" ? undefined : req.body,
          // @ts-expect-error Bun streaming upload
          duplex: "half",
        });
      } catch {
        return Response.json(
          { success: false, error: `dev proxy: backend unreachable at ${API} (run \`bun run dev\`)` },
          { status: 502 },
        );
      }
    }

    if (req.method === "GET" || req.method === "HEAD") {
      const pubFile = resolvePublicFile(url.pathname);
      if (pubFile) return new Response(Bun.file(pubFile));
    }
    return new Response("Not found", { status: 404 });
  },
  development: { hmr: false, console: true },
  port,
});

console.log(`[dev-web] ${server.url} (proxying /api/* and /d/* -> ${API})`);
