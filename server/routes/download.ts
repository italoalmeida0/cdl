import { open } from "node:fs/promises";

import { BASE_PATH, CDL_SECRET, LIMITS, PUBLIC_BASE_URL, TRUST_PROXY, parseBaseUrl } from "../config";
import { randomToken, signUnlockCookie, verifyPassword, verifyUnlockCookie } from "../crypto";
import { db, getSetting, type LinkRow } from "../db";
import { getCachedChecksum, resolveLinkFile } from "../files";
import { baseHeaders, clientIp, encodeContentDisposition, err, ipMatchesWhitelist } from "../http";
import { authorizeDownloadRequest, parseWhitelistJson, recordDownloadEvent, refreshLinkActivity } from "../links";
import { bruteforceClear, bruteforceFail, bruteforceLocked, limits } from "../ratelimit";
import { finishTransfer, registerTransfer, updateTransferProgress } from "../transfers";

interface ParsedRange {
  start: number;
  end: number;
  isRange: boolean;
}

function parseRangeHeader(
  rangeHeader: string | null,
  fileSize: number,
): ParsedRange | { invalid: true } {
  if (!rangeHeader) {
    return { start: 0, end: Math.max(0, fileSize - 1), isRange: false };
  }
  const m = rangeHeader.trim().match(/^bytes=(\d*)-(\d*)$/i);
  if (!m) return { invalid: true };
  if (fileSize === 0) return { invalid: true };

  const startStr = m[1]!;
  const endStr = m[2]!;
  if (!startStr && !endStr) return { invalid: true };

  let start: number;
  let end: number;
  if (!startStr) {
    const suffix = Number(endStr);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return { invalid: true };
    start = Math.max(0, fileSize - suffix);
    end = fileSize - 1;
  } else {
    start = Number(startStr);
    end = endStr ? Math.min(fileSize - 1, Number(endStr)) : fileSize - 1;
  }

  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= fileSize) {
    return { invalid: true };
  }
  return { start, end, isRange: true };
}

function parseCookies(cookieHeader: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!cookieHeader) return out;
  for (const part of cookieHeader.split(";")) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    const k = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (k) out[k] = val;
  }
  return out;
}

function extractSuppliedPassword(req: Request): string | null {
  const headerPw = req.headers.get("x-cdl-password");
  if (headerPw !== null) return headerPw;
  const auth = req.headers.get("authorization");
  if (auth && auth.toLowerCase().startsWith("basic ")) {
    try {
      const decoded = Buffer.from(auth.slice(6).trim(), "base64").toString("utf8");
      const colon = decoded.indexOf(":");
      return colon === -1 ? decoded : decoded.slice(colon + 1);
    } catch {
      return null;
    }
  }
  return null;
}

function activeBasePath(): string {
  if (BASE_PATH) return BASE_PATH;
  const override = getSetting("base_url_override");
  if (override) return parseBaseUrl(override).basePath;
  return "";
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function renderUnlockHtml(opts: {
  token: string;
  filename: string;
  actionUrl: string;
  wrongPassword: boolean;
}): Response {
  const h = baseHeaders(
    undefined,
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  );
  h.set("Content-Type", "text/html; charset=utf-8");
  h.set("Cache-Control", "no-store");
  h.set("X-Robots-Tag", "noindex, nofollow");

  const errorBanner = opts.wrongPassword
    ? `<p class="err">Incorrect password. Please try again.</p>`
    : "";

  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="robots" content="noindex, nofollow" />
  <title>CDL · Password Required</title>
  <style>
    :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, -apple-system, sans-serif; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 1.5rem; background: #121214; color: #f4f4f5; }
    @media (prefers-color-scheme: light) {
      body { background: #fafafa; color: #18181b; }
      .card { background: #fff; border-color: #e4e4e7; }
      input { background: #fff; color: #18181b; border-color: #d4d4d8; }
      button { background: #18181b; color: #fff; }
    }
    .card { width: 100%; max-width: 380px; padding: 1.75rem; border-radius: 18px; border: 1px solid #27272a; background: #18181b; box-shadow: 0 20px 50px rgba(0,0,0,.25); }
    .tag { font-size: 11px; letter-spacing: .08em; text-transform: uppercase; opacity: .65; margin-bottom: .5rem; font-weight: 600; }
    h1 { margin: 0 0 .35rem; font-size: 1.15rem; font-weight: 600; word-break: break-word; }
    p { margin: 0 0 1rem; font-size: .875rem; opacity: .75; line-height: 1.45; }
    .err { color: #f43f5e; opacity: 1; font-weight: 500; }
    input { width: 100%; box-sizing: border-box; height: 42px; padding: 0 .85rem; border-radius: 12px; border: 1px solid #3f3f46; background: #121214; color: #f4f4f5; font-size: .95rem; margin-bottom: .85rem; outline: none; }
    input:focus { border-color: #2dd4bf; }
    button { width: 100%; height: 42px; border: 0; border-radius: 12px; font-weight: 600; font-size: .95rem; cursor: pointer; background: #f4f4f5; color: #18181b; }
    button:hover { opacity: .92; }
  </style>
</head>
<body>
  <main class="card">
    <div class="tag">CDL · Protected Download</div>
    <h1>${escapeHtml(opts.filename)}</h1>
    <p>Enter the password to start downloading this file.</p>
    ${errorBanner}
    <form method="POST" action="${escapeHtml(opts.actionUrl)}">
      <input type="password" name="password" placeholder="Download password" autocomplete="current-password" autofocus required />
      <button type="submit">Unlock &amp; Download</button>
    </form>
  </main>
</body>
</html>`;
  return new Response(html, { status: opts.wrongPassword ? 401 : 401, headers: h });
}

export async function handleDownloadRoute(
  reqPath: string,
  req: Request,
  url: URL,
  server?: any,
): Promise<Response | null> {
  // POST /d/:token/unlock -> browser password form handler
  const unlockMatch = reqPath.match(/^\/d\/([A-Za-z0-9_-]+)\/unlock$/);
  if (unlockMatch && req.method === "POST") {
    const token = unlockMatch[1]!;
    const ip = clientIp(req, server);
    const ua = req.headers.get("user-agent") || "";
    const link = db.query<LinkRow, [string]>("SELECT * FROM links WHERE token = ?").get(token);
    if (!link) return err(404, "Download link not found", req);
    if (link.status === "revoked") return err(410, "This download link has been revoked", req, "revoked");
    if (link.status === "paused") return err(423, "This download link is temporarily paused", req, "paused");
    if (link.status === "expired") return err(410, "This download link has expired", req, "expired");

    const whitelist = parseWhitelistJson(link.ip_whitelist);
    if (whitelist.length > 0 && !ipMatchesWhitelist(ip, whitelist)) {
      return err(403, "Your IP address is not permitted to access this link", req, "ip_not_whitelisted");
    }
    if (link.lock_to_first_ip && link.locked_ip && link.locked_ip !== ip) {
      return err(403, "This link is locked to another IP address", req, "ip_locked");
    }

    const bfScope = `dlpw:${link.id}:${ip}`;
    const locked = bruteforceLocked(bfScope);
    if (locked > 0) {
      return err(429, `Too many password attempts. Retry in ${locked}s`, req);
    }

    const rawBody = await req.text();
    const params = new URLSearchParams(rawBody);
    const password = params.get("password") ?? "";
    if (!link.password_hash || !(await verifyPassword(password, link.password_hash))) {
      bruteforceFail(bfScope, LIMITS.linkFailMax, LIMITS.linkFailWindowMs, LIMITS.linkLockoutMs);
      recordDownloadEvent({
        linkId: link.id,
        ip,
        userAgent: ua,
        method: "POST",
        bytesSent: 0,
        status: 401,
        outcome: "denied_bad_password",
        durationMs: 0,
      });
      const base = activeBasePath();
      return renderUnlockHtml({
        token,
        filename: link.download_filename,
        actionUrl: `${base}/d/${token}/unlock`,
        wrongPassword: true,
      });
    }

    bruteforceClear(bfScope);
    const cookieVal = await signUnlockCookie(link.id, link.password_hash, CDL_SECRET);
    const base = activeBasePath();
    const cookieScope = `${base}/d/${token}`;
    const targetUrl = `${base}/d/${token}/${encodeURIComponent(link.download_filename)}`;
    const isHttps =
      url.protocol === "https:" ||
      (TRUST_PROXY && req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() === "https") ||
      PUBLIC_BASE_URL.startsWith("https://");
    const h = new Headers();
    h.set("Location", targetUrl);
    h.set(
      "Set-Cookie",
      `cdl_unlock_${token}=${cookieVal}; Path=${cookieScope}; HttpOnly; SameSite=Lax; Max-Age=43200${isHttps ? "; Secure" : ""}`,
    );
    return new Response(null, { status: 303, headers: h });
  }

  const dlMatch = reqPath.match(/^\/d\/([A-Za-z0-9_-]+)(?:\/([^/]+))?$/);
  if (!dlMatch) return null;
  if (req.method !== "GET" && req.method !== "HEAD") {
    return err(405, "Method not allowed", req);
  }

  const token = dlMatch[1]!;
  const isHead = req.method === "HEAD";
  const ip = clientIp(req, server);
  const ua = req.headers.get("user-agent") || "";
  const startedAt = Date.now();

  const linkPreview = db.query<LinkRow, [string]>("SELECT * FROM links WHERE token = ?").get(token);
  if (!linkPreview) {
    const retry = limits.downloadFailPerMin(ip);
    if (retry > 0) return err(429, "Too many requests", req);
    return err(404, "Download link not found", req);
  }

  const bfScope = `dlpw:${linkPreview.id}:${ip}`;
  const locked = bruteforceLocked(bfScope);
  if (locked > 0) {
    return err(429, `Too many password attempts. Retry in ${locked}s`, req);
  }

  const resolvedFile = resolveLinkFile(linkPreview);
  if (!resolvedFile.exists) {
    recordDownloadEvent({
      linkId: linkPreview.id,
      ip,
      userAgent: ua,
      method: req.method,
      bytesSent: 0,
      status: 404,
      outcome: "file_missing",
      durationMs: Date.now() - startedAt,
    });
    return err(404, "File no longer exists on disk", req, "file_missing");
  }

  const rangeHeader = req.headers.get("range");
  const prelimRange = parseRangeHeader(rangeHeader, resolvedFile.size);
  const rangeStartForAuth = "invalid" in prelimRange ? null : prelimRange.isRange ? prelimRange.start : 0;

  const cookies = parseCookies(req.headers.get("cookie"));
  const cookieName = `cdl_unlock_${token}`;
  const unlockCookieValid =
    !!linkPreview.password_hash &&
    !!cookies[cookieName] &&
    (await verifyUnlockCookie(cookies[cookieName]!, linkPreview.id, linkPreview.password_hash, CDL_SECRET));

  const suppliedPassword = extractSuppliedPassword(req);
  const authResult = await authorizeDownloadRequest({
    token,
    ip,
    isHead,
    rangeStart: rangeStartForAuth,
    suppliedPassword,
    unlockCookieValid,
  });

  if (!authResult.allowed) {
    if (authResult.outcome === "denied_bad_password") {
      bruteforceFail(bfScope, LIMITS.linkFailMax, LIMITS.linkFailWindowMs, LIMITS.linkLockoutMs);
    }
    recordDownloadEvent({
      linkId: linkPreview.id,
      ip,
      userAgent: ua,
      method: req.method,
      rangeStart: rangeStartForAuth,
      bytesSent: 0,
      status: authResult.status,
      outcome: authResult.outcome,
      durationMs: Date.now() - startedAt,
    });

    if (authResult.needsPasswordPrompt) {
      const accept = req.headers.get("accept") || "";
      if (!isHead && accept.includes("text/html") && suppliedPassword === null) {
        const base = activeBasePath();
        return renderUnlockHtml({
          token,
          filename: linkPreview.download_filename,
          actionUrl: `${base}/d/${token}/unlock`,
          wrongPassword: false,
        });
      }
      const res = err(401, authResult.message, req, authResult.code);
      res.headers.set("WWW-Authenticate", 'Basic realm="CDL Protected File"');
      return res;
    }

    return err(authResult.status, authResult.message, req, authResult.code);
  }

  if (suppliedPassword !== null) bruteforceClear(bfScope);

  const link = authResult.link;
  const etag = `"${resolvedFile.size.toString(16)}-${resolvedFile.mtimeMs.toString(16)}"`;
  const lastModified = new Date(resolvedFile.mtimeMs).toUTCString();

  // Handle If-Range per RFC 9110: ignore Range if validator does not match
  let effectiveRangeHeader = rangeHeader;
  const ifRange = req.headers.get("if-range");
  if (ifRange && effectiveRangeHeader) {
    const trimmed = ifRange.trim();
    const matchesEtag = trimmed === etag || trimmed === `W/${etag}`;
    const parsedTime = Date.parse(trimmed);
    const matchesDate = Number.isFinite(parsedTime) && Math.floor(parsedTime / 1000) >= Math.floor(resolvedFile.mtimeMs / 1000);
    if (!matchesEtag && !matchesDate) {
      effectiveRangeHeader = null;
    }
  }

  const parsedRange = parseRangeHeader(effectiveRangeHeader, resolvedFile.size);
  if ("invalid" in parsedRange) {
    const h = baseHeaders(req);
    h.set("Content-Range", `bytes */${resolvedFile.size}`);
    h.set("Accept-Ranges", "bytes");
    return new Response(null, { status: 416, headers: h });
  }

  const useInline = !!link.allow_inline && url.searchParams.get("inline") === "1";
  const disposition = encodeContentDisposition(link.download_filename, useInline ? "inline" : "attachment");

  const headers = baseHeaders(req);
  headers.set("Content-Type", resolvedFile.mimeType);
  headers.set("Content-Disposition", disposition);
  headers.set("Accept-Ranges", "bytes");
  headers.set("ETag", etag);
  headers.set("Last-Modified", lastModified);
  headers.set("Cache-Control", "private, no-store");
  headers.set("X-Robots-Tag", "noindex, nofollow");
  headers.set("Referrer-Policy", "no-referrer");

  const cachedSha = getCachedChecksum(resolvedFile.fileKey, resolvedFile.size, resolvedFile.mtimeMs);
  if (cachedSha) headers.set("X-Checksum-SHA256", cachedSha);

  const rangeLength = resolvedFile.size === 0 ? 0 : parsedRange.end - parsedRange.start + 1;
  headers.set("Content-Length", String(rangeLength));
  if (parsedRange.isRange) {
    headers.set("Content-Range", `bytes ${parsedRange.start}-${parsedRange.end}/${resolvedFile.size}`);
  }

  const status = parsedRange.isRange ? 206 : 200;

  if (isHead || resolvedFile.size === 0) {
    recordDownloadEvent({
      linkId: link.id,
      ip,
      userAgent: ua,
      method: req.method,
      rangeStart: parsedRange.isRange ? parsedRange.start : null,
      rangeEnd: parsedRange.isRange ? parsedRange.end : null,
      bytesSent: 0,
      status,
      outcome: isHead ? "head_ok" : "completed",
      durationMs: Date.now() - startedAt,
    });
    return new Response(null, { status, headers });
  }

  // Exempt multi-hour 1TB+ downloads from Bun's socket idle timeout
  if (server?.timeout) {
    server.timeout(req, 0);
  }

  const transferId = randomToken(10);
  const abortController = new AbortController();
  const transfer = registerTransfer({
    id: transferId,
    linkId: link.id,
    token: link.token,
    filename: link.download_filename,
    ip,
    userAgent: ua,
    rangeStart: parsedRange.start,
    rangeEnd: parsedRange.end,
    totalRangeBytes: rangeLength,
    fileSize: resolvedFile.size,
    abortController,
  });

  const reqSignal = req.signal;
  const onReqAbort = () => {
    try {
      abortController.abort(new Error("client_aborted"));
    } catch {}
  };
  if (reqSignal.aborted) {
    onReqAbort();
  } else {
    reqSignal.addEventListener("abort", onReqAbort, { once: true });
  }

  const fh = await open(resolvedFile.absPath, "r");
  const chunkSize = LIMITS.streamChunkBytes;
  const maxBytesPerSec = link.max_speed_kbps ? link.max_speed_kbps * 1024 : 0;

  let cursor = parsedRange.start;
  const endInclusive = parsedRange.end;
  let bytesSent = 0;
  let lastDbFlushedBytes = 0;
  let cleanedUp = false;
  let streamOutcome = "completed";
  let tokenBudgetBytes = maxBytesPerSec;
  let lastRefillMs = Date.now();

  const cleanup = (outcome: string) => {
    if (cleanedUp) return;
    cleanedUp = true;
    streamOutcome = outcome;
    clearInterval(heartbeat);
    reqSignal.removeEventListener("abort", onReqAbort);
    finishTransfer(transferId);
    const delta = bytesSent - lastDbFlushedBytes;
    lastDbFlushedBytes = bytesSent;
    try {
      refreshLinkActivity(link.id, ip, delta);
      recordDownloadEvent({
        linkId: link.id,
        ip,
        userAgent: ua,
        method: "GET",
        rangeStart: parsedRange.isRange ? parsedRange.start : null,
        rangeEnd: parsedRange.isRange ? parsedRange.end : null,
        bytesSent,
        status,
        outcome: streamOutcome,
        durationMs: Date.now() - startedAt,
      });
    } catch {}
    void fh.close().catch(() => {});
  };

  // Heartbeat keeps active downloads refreshing sliding debounce & authorized IP activity every 30s
  const heartbeat = setInterval(() => {
    if (cleanedUp) return;
    const delta = bytesSent - lastDbFlushedBytes;
    lastDbFlushedBytes = bytesSent;
    try {
      refreshLinkActivity(link.id, ip, delta);
    } catch {}
  }, LIMITS.heartbeatIntervalMs);
  heartbeat.unref?.();

  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (abortController.signal.aborted) {
          const reason = String((abortController.signal.reason as Error | undefined)?.message ?? "aborted");
          cleanup(reason === "aborted_by_admin" ? "killed" : "aborted");
          try {
            controller.error(new Error(reason));
          } catch {}
          return;
        }

        if (cursor > endInclusive) {
          cleanup("completed");
          controller.close();
          return;
        }

        if (maxBytesPerSec > 0) {
          const nowMs = Date.now();
          const elapsed = Math.max(0, nowMs - lastRefillMs);
          if (elapsed > 0) {
            tokenBudgetBytes = Math.min(maxBytesPerSec, tokenBudgetBytes + (maxBytesPerSec * elapsed) / 1000);
            lastRefillMs = nowMs;
          }
          if (tokenBudgetBytes < 1024) {
            const waitMs = Math.max(5, Math.ceil(((1024 - tokenBudgetBytes) * 1000) / maxBytesPerSec));
            await new Promise((r) => setTimeout(r, waitMs));
            const afterMs = Date.now();
            tokenBudgetBytes = Math.min(
              maxBytesPerSec,
              tokenBudgetBytes + (maxBytesPerSec * Math.max(0, afterMs - lastRefillMs)) / 1000,
            );
            lastRefillMs = afterMs;
          }
        }

        const remaining = endInclusive - cursor + 1;
        const maxAllowed = maxBytesPerSec > 0 ? Math.max(1024, Math.floor(tokenBudgetBytes)) : chunkSize;
        const toRead = Math.min(chunkSize, remaining, maxAllowed);
        const buf = new Uint8Array(toRead);
        const { bytesRead } = await fh.read(buf, 0, toRead, cursor);

        if (abortController.signal.aborted) {
          const reason = String((abortController.signal.reason as Error | undefined)?.message ?? "aborted");
          cleanup(reason === "aborted_by_admin" ? "killed" : "aborted");
          try {
            controller.error(new Error(reason));
          } catch {}
          return;
        }

        if (bytesRead <= 0) {
          cleanup(bytesSent >= rangeLength ? "completed" : "aborted");
          controller.close();
          return;
        }

        const slice = bytesRead === toRead ? buf : buf.subarray(0, bytesRead);
        cursor += bytesRead;
        bytesSent += bytesRead;
        if (maxBytesPerSec > 0) tokenBudgetBytes -= bytesRead;
        updateTransferProgress(transferId, bytesRead);
        controller.enqueue(slice);

        if (cursor > endInclusive) {
          cleanup("completed");
          controller.close();
        }
      } catch (readErr) {
        cleanup("aborted");
        try {
          controller.error(readErr);
        } catch {}
      }
    },
    cancel() {
      cleanup(bytesSent >= rangeLength ? "completed" : "aborted");
    },
  });

  // Ensure transfer reference keeps TS happy
  void transfer;
  return new Response(body, { status, headers });
}
