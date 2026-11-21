import { bootstrapAdminFromEnv } from "./auth";
import {
  BASE_PATH,
  DATA_DIR,
  FILES_DIR,
  HOST,
  IS_PROD,
  LIMITS,
  PORT,
  PUBLIC_BASE_URL,
  UPLOAD_CHUNK_MAX_BYTES,
  parseBaseUrl,
} from "./config";
import { getSetting, runPassiveWalCheckpoint } from "./db";
import { ApiError, baseHeaders, clientIp, err, json, rateLimitError } from "./http";
import { sweepMaintenance } from "./links";
import { limits } from "./ratelimit";
import { handleAuthRoute } from "./routes/auth";
import { handleDownloadRoute } from "./routes/download";
import { handleFilesRoute } from "./routes/files";
import { handleLinksRoute } from "./routes/links";
import { handleUploadsRoute } from "./routes/uploads";
import { serveStatic } from "./static";

await bootstrapAdminFromEnv();

function activeBasePath(): string {
  if (BASE_PATH) return BASE_PATH;
  const override = getSetting("base_url_override");
  if (override) return parseBaseUrl(override).basePath;
  return "";
}

function stripBasePath(pathname: string): string {
  const base = activeBasePath();
  if (!base) return pathname;
  if (pathname === base) return "/";
  if (pathname.startsWith(base + "/")) {
    return pathname.slice(base.length) || "/";
  }
  return pathname;
}

export async function route(req: Request, server?: any): Promise<Response> {
  const url = new URL(req.url);
  try {
    return await dispatch(req, url, server);
  } catch (e) {
    if (req.signal.aborted) return new Response(null, { status: 499 });
    if (e instanceof ApiError) {
      return err(e.status, e.message, req, e.code);
    }
    console.error(`[HTTP] unhandled error on ${req.method} ${url.pathname}:`, e);
    return err(500, "internal error", req);
  }
}

async function dispatch(req: Request, url: URL, server?: any): Promise<Response> {
  const rawPath = url.pathname;

  if (rawPath.includes("..")) {
    return err(400, "bad path", req);
  }

  // Redirect exact subpath without trailing slash (e.g. /lalala -> /lalala/)
  const base = activeBasePath();
  if (base && rawPath === base && (req.method === "GET" || req.method === "HEAD")) {
    const h = baseHeaders(req);
    h.set("Location", `${base}/${url.search}`);
    return new Response(null, { status: 302, headers: h });
  }

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: baseHeaders(req) });
  }

  const path = stripBasePath(rawPath);

  // Healthcheck (exempt from rate limits)
  if (path === "/api/health" && (req.method === "GET" || req.method === "HEAD")) {
    return json({ ok: true, service: "cdl", ts: Date.now() }, { req });
  }

  const ip = clientIp(req, server);
  const retry = limits.ipPerMin(ip);
  if (retry > 0) {
    return rateLimitError(`rate limit exceeded, retry in ${retry}s`, retry, req);
  }

  if (path.startsWith("/d/")) {
    const dlResp = await handleDownloadRoute(path, req, url, server);
    if (dlResp) return dlResp;
    return err(404, "not found", req);
  }

  if (path.startsWith("/api/")) {
    const viaAuth = await handleAuthRoute(path, req, server);
    if (viaAuth) return viaAuth;

    const viaFiles = await handleFilesRoute(path, req, url);
    if (viaFiles) return viaFiles;

    const viaUploads = await handleUploadsRoute(path, req, url, server);
    if (viaUploads) return viaUploads;

    const viaLinks = await handleLinksRoute(path, req, url, server);
    if (viaLinks) return viaLinks;

    return err(404, "not found", req);
  }

  if (req.method === "GET" || req.method === "HEAD") {
    const staticResp = serveStatic(req, path);
    if (staticResp) return staticResp;
  }

  return err(404, "not found", req);
}

const isTestEnv = process.env.NODE_ENV === "test";

if (!isTestEnv) {
  // Run initial sweep and schedule periodic sweeps + WAL checkpoints
  try {
    sweepMaintenance();
  } catch (e) {
    console.warn("[SWEEP] initial sweep failed:", e);
  }

  const sweepTimer = setInterval(() => {
    try {
      sweepMaintenance();
    } catch (e) {
      console.warn("[SWEEP] periodic sweep failed:", e);
    }
  }, LIMITS.sweepIntervalMs);
  sweepTimer.unref?.();

  const walTimer = setInterval(() => {
    runPassiveWalCheckpoint();
  }, LIMITS.walCheckpointIntervalMs);
  walTimer.unref?.();

  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      console.log(`\n[BOOT] ${sig} received, checkpointing WAL and shutting down...`);
      runPassiveWalCheckpoint();
      process.exit(0);
    });
  }
}

export const server = isTestEnv
  ? null
  : Bun.serve({
      port: PORT,
      hostname: HOST,
      maxRequestBodySize: UPLOAD_CHUNK_MAX_BYTES + 1024 * 1024,
      idleTimeout: 120,
      async fetch(req, srv) {
        try {
          return await route(req, srv);
        } catch (e) {
          if (req.signal.aborted) return new Response(null, { status: 499 });
          if (e instanceof ApiError) {
            return err(e.status, e.message, req, e.code);
          }
          console.error(`[HTTP] unhandled error on ${req.method} ${req.url}:`, e);
          return err(500, "internal error", req);
        }
      },
    });

if (server) {
  console.log(
    `[BOOT] CDL listening on http://${server.hostname}:${server.port} (${IS_PROD ? "prod" : "dev"})`,
  );
  console.log(`[BOOT] data=${DATA_DIR} files=${FILES_DIR} base=${PUBLIC_BASE_URL || "(auto)"}`);
}
