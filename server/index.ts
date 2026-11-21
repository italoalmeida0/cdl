import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
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

function incomingToWebRequest(req: IncomingMessage, res: ServerResponse): Request {
  const host = req.headers.host || `127.0.0.1:${PORT}`;
  const url = `http://${host}${req.url || "/"}`;
  const headers = new Headers();
  for (const [k, val] of Object.entries(req.headers)) {
    if (val === undefined) continue;
    if (Array.isArray(val)) {
      for (const item of val) headers.append(k, item);
    } else {
      headers.set(k, val);
    }
  }

  const ac = new AbortController();
  const onAbort = () => {
    if (!res.writableFinished) ac.abort();
  };
  req.on("aborted", onAbort);
  res.on("close", onAbort);

  const method = (req.method || "GET").toUpperCase();
  const hasBody = method !== "GET" && method !== "HEAD";
  const maxBodyBytes = UPLOAD_CHUNK_MAX_BYTES + 1024 * 1024;
  let body: ReadableStream<Uint8Array> | undefined;

  if (hasBody) {
    let seenBytes = 0;
    body = new ReadableStream<Uint8Array>({
      start(controller) {
        req.on("data", (chunk: Buffer | Uint8Array) => {
          seenBytes += chunk.byteLength;
          if (seenBytes > maxBodyBytes) {
            const err = new ApiError(413, "payload too large");
            controller.error(err);
            req.destroy();
            return;
          }
          controller.enqueue(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk));
        });
        req.on("end", () => {
          try {
            controller.close();
          } catch {}
        });
        req.on("error", (err) => {
          try {
            controller.error(err);
          } catch {}
        });
      },
      cancel() {
        req.destroy();
      },
    });
  }

  return new Request(url, {
    method,
    headers,
    body,
    signal: ac.signal,
    // @ts-expect-error Bun streaming Request body
    duplex: hasBody ? "half" : undefined,
  });
}

async function writeWebResponse(req: IncomingMessage, res: ServerResponse, response: Response): Promise<void> {
  if (res.headersSent || res.writableEnded || res.destroyed) return;

  const outHeaders: Record<string, string | string[]> = {};
  const headersAny = response.headers as Headers & { getSetCookie?: () => string[] };
  const setCookies = typeof headersAny.getSetCookie === "function" ? headersAny.getSetCookie() : [];

  response.headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (lower === "set-cookie" || lower === "transfer-encoding") return;
    outHeaders[key] = value;
  });
  if (setCookies.length > 0) {
    outHeaders["set-cookie"] = setCookies;
  }

  const method = (req.method || "GET").toUpperCase();
  if (method === "HEAD" || response.status === 204 || response.status === 304) {
    res.writeHead(response.status, outHeaders);
    res.end();
    return;
  }

  const buf = Buffer.from(await response.arrayBuffer());
  if (!outHeaders["content-length"]) {
    outHeaders["content-length"] = String(buf.byteLength);
  }
  res.writeHead(response.status, outHeaders);
  res.end(buf);
}

export function createHttpServer() {
  const srv = createServer(async (incoming, res) => {
    const webReq = incomingToWebRequest(incoming, res);
    const peerServer = {
      requestIP: () => ({ address: incoming.socket.remoteAddress ?? "" }),
      timeout: (_r: Request, sec: number) => {
        const ms = sec <= 0 ? 0 : sec * 1000;
        incoming.setTimeout(ms);
        res.setTimeout(ms);
        incoming.socket?.setTimeout(ms);
      },
      nodeRes: res,
    };

    try {
      const response = await route(webReq, peerServer);
      await writeWebResponse(incoming, res, response);
    } catch (e) {
      if (res.headersSent || res.writableEnded || res.destroyed) return;
      if (webReq.signal.aborted) {
        res.writeHead(499);
        res.end();
        return;
      }
      const fallback =
        e instanceof ApiError ? err(e.status, e.message, webReq, e.code) : err(500, "internal error", webReq);
      await writeWebResponse(incoming, res, fallback);
    }
  });
  srv.requestTimeout = 0;
  srv.headersTimeout = 60_000;
  srv.keepAliveTimeout = 65_000;
  return srv;
}

export const server = isTestEnv
  ? null
  : (() => {
      const srv = createHttpServer();
      srv.listen(PORT, HOST, () => {
        console.log(
          `[BOOT] CDL listening on http://${HOST}:${PORT} (${IS_PROD ? "prod" : "dev"})`,
        );
        console.log(`[BOOT] data=${DATA_DIR} files=${FILES_DIR} base=${PUBLIC_BASE_URL || "(auto)"}`);
      });
      return srv;
    })();
