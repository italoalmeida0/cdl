import { requireAdmin } from "../auth";
import {
  BASE_PATH,
  ENV_BASE_URL_SET,
  FILES_DIR,
  LIMITS,
  PUBLIC_BASE_URL,
  TRUST_PROXY,
  UPLOAD_CHUNK_MAX_BYTES,
  parseBaseUrl,
} from "../config";
import { audit, db, getSetting, setSetting, type AuditLogRow } from "../db";
import { mountStatus } from "../files";
import { ApiError, clientIp, ok, readJsonBody, v } from "../http";
import {
  createLink,
  deleteLink,
  extendLink,
  getDefaultPolicy,
  getEffectivePublicBaseUrl,
  getLinkDetail,
  listLinks,
  revokeLink,
  saveDefaultPolicy,
  unlockLinkIp,
  updateLink,
  type CreateLinkInput,
  type UpdateLinkInput,
} from "../links";
import { abortTransfer, liveSnapshot, liveStatsSummary } from "../transfers";

export async function handleLinksRoute(
  reqPath: string,
  req: Request,
  url: URL,
  server?: any,
): Promise<Response | null> {
  const ip = clientIp(req, server);

  // Overview stats
  if (reqPath === "/api/overview" && req.method === "GET") {
    await requireAdmin(req);
    const baseUrl = getEffectivePublicBaseUrl(req);
    const links = listLinks(baseUrl);
    const live = liveStatsSummary();
    const totalServedRow = db
      .query<{ totalBytes: number; totalDownloads: number }, []>(
        "SELECT COALESCE(SUM(total_bytes_served), 0) AS totalBytes, COALESCE(SUM(download_count), 0) AS totalDownloads FROM links",
      )
      .get()!;
    const activeLinksCount = links.filter(
      (l) => l.effectiveStatus === "active" || l.effectiveStatus === "resume_only",
    ).length;
    const recentEvents = db
      .query<
        {
          id: number;
          link_id: string;
          label: string;
          download_filename: string;
          ts: number;
          ip: string;
          method: string;
          bytes_sent: number;
          status: number;
          outcome: string;
          duration_ms: number;
        },
        []
      >(
        `SELECT e.id, e.link_id, l.label, l.download_filename, e.ts, e.ip, e.method, e.bytes_sent, e.status, e.outcome, e.duration_ms
         FROM download_events e
         LEFT JOIN links l ON l.id = e.link_id
         ORDER BY e.ts DESC LIMIT 15`,
      )
      .all();

    return ok(
      {
        stats: {
          totalLinks: links.length,
          activeLinks: activeLinksCount,
          activeTransfers: live.activeCount,
          currentBytesPerSec: live.totalBytesPerSec,
          totalDownloads: totalServedRow.totalDownloads,
          totalBytesServed: totalServedRow.totalBytes,
        },
        mount: mountStatus(),
        publicBaseUrl: baseUrl,
        recentLinks: links.slice(0, 6),
        liveTransfers: liveSnapshot(),
        recentEvents: recentEvents.map((e) => ({
          id: e.id,
          linkId: e.link_id,
          label: e.label ?? "Deleted link",
          filename: e.download_filename ?? "",
          ts: e.ts,
          ip: e.ip,
          method: e.method,
          bytesSent: e.bytes_sent,
          status: e.status,
          outcome: e.outcome,
          durationMs: e.duration_ms,
        })),
      },
      req,
    );
  }

  // Live transfers
  if (reqPath === "/api/transfers/live" && req.method === "GET") {
    await requireAdmin(req);
    const linkId = url.searchParams.get("linkId") || undefined;
    return ok({ transfers: liveSnapshot(linkId), summary: liveStatsSummary() }, req);
  }

  const killMatch = reqPath.match(/^\/api\/transfers\/([a-f0-9]+)$/);
  if (killMatch && req.method === "DELETE") {
    await requireAdmin(req);
    const killed = abortTransfer(killMatch[1]!);
    if (!killed) throw new ApiError(404, "Transfer not active");
    audit("transfer.killed", { target: killMatch[1]!, ip });
    return ok({}, req);
  }

  // Links collection
  if (reqPath === "/api/links" && req.method === "GET") {
    await requireAdmin(req);
    const baseUrl = getEffectivePublicBaseUrl(req);
    const q = url.searchParams.get("q") ?? "";
    const status = url.searchParams.get("status") ?? "";
    const sourceType = url.searchParams.get("sourceType") ?? "";
    const links = listLinks(baseUrl, { q, status, sourceType });
    return ok({ links, publicBaseUrl: baseUrl }, req);
  }

  if (reqPath === "/api/links" && req.method === "POST") {
    await requireAdmin(req);
    const body = await readJsonBody(req, LIMITS.apiBodyBytes);
    const baseUrl = getEffectivePublicBaseUrl(req);
    const payload: CreateLinkInput = {
      sourceType: v.str(body, "sourceType") as "mount" | "upload",
      sourcePath: v.str(body, "sourcePath", { optional: true, max: 1024 }) ?? undefined,
      uploadId: v.str(body, "uploadId", { optional: true, max: 128 }) ?? undefined,
      label: v.str(body, "label", { optional: true, max: 140 }) ?? undefined,
      downloadFilename: v.str(body, "downloadFilename", { optional: true, max: 256 }) ?? undefined,
      expiryMode: (v.str(body, "expiryMode", { optional: true }) ?? undefined) as CreateLinkInput["expiryMode"],
      idleTtlSec: v.int(body, "idleTtlSec", { optional: true, min: 60, max: 365 * 24 * 3600 }) ?? undefined,
      fixedTtlSec: v.int(body, "fixedTtlSec", { optional: true, min: 60, max: 10 * 365 * 24 * 3600 }) ?? undefined,
      expiresAt: body.expiresAt === null ? null : v.int(body, "expiresAt", { optional: true, min: 1 }) ?? undefined,
      hardExpiresAt:
        body.hardExpiresAt === null ? null : v.int(body, "hardExpiresAt", { optional: true, min: 1 }) ?? undefined,
      startedIpCanResume:
        body.startedIpCanResume === undefined ? undefined : v.bool(body, "startedIpCanResume"),
      resumeGraceSec:
        v.int(body, "resumeGraceSec", { optional: true, min: 0, max: 365 * 24 * 3600 }) ?? undefined,
      lockToFirstIp: body.lockToFirstIp === undefined ? undefined : v.bool(body, "lockToFirstIp"),
      ipWhitelist: body.ipWhitelist as string[] | string | undefined,
      maxDownloads:
        body.maxDownloads === null ? null : v.int(body, "maxDownloads", { optional: true, min: 1, max: 1_000_000 }) ?? undefined,
      password: v.str(body, "password", { optional: true, max: 256 }),
      allowInline: body.allowInline === undefined ? undefined : v.bool(body, "allowInline"),
      autoDeleteFile: body.autoDeleteFile === undefined ? undefined : v.bool(body, "autoDeleteFile"),
      maxSpeedKbps:
        body.maxSpeedKbps === null ? null : v.int(body, "maxSpeedKbps", { optional: true, min: 1, max: 10_000_000 }) ?? undefined,
      notes: v.str(body, "notes", { optional: true, max: 1000 }) ?? undefined,
    };
    const link = await createLink(payload, baseUrl, ip);
    return ok({ link }, req);
  }

  // Link item routes
  const extendMatch = reqPath.match(/^\/api\/links\/([a-f0-9]+)\/extend$/);
  if (extendMatch && req.method === "POST") {
    await requireAdmin(req);
    const body = await readJsonBody(req, LIMITS.apiBodyBytes);
    const seconds = v.int(body, "seconds", { min: 60, max: 365 * 24 * 3600 })!;
    const link = extendLink(extendMatch[1]!, seconds, getEffectivePublicBaseUrl(req), ip);
    return ok({ link }, req);
  }

  const unlockIpMatch = reqPath.match(/^\/api\/links\/([a-f0-9]+)\/unlock-ip$/);
  if (unlockIpMatch && req.method === "POST") {
    await requireAdmin(req);
    const link = unlockLinkIp(unlockIpMatch[1]!, getEffectivePublicBaseUrl(req), ip);
    return ok({ link }, req);
  }

  const revokeMatch = reqPath.match(/^\/api\/links\/([a-f0-9]+)\/revoke$/);
  if (revokeMatch && req.method === "POST") {
    await requireAdmin(req);
    const link = revokeLink(revokeMatch[1]!, getEffectivePublicBaseUrl(req), ip);
    return ok({ link }, req);
  }

  const itemMatch = reqPath.match(/^\/api\/links\/([a-f0-9]+)$/);
  if (itemMatch) {
    await requireAdmin(req);
    const id = itemMatch[1]!;
    const baseUrl = getEffectivePublicBaseUrl(req);

    if (req.method === "GET") {
      return ok(getLinkDetail(id, baseUrl), req);
    }

    if (req.method === "PATCH") {
      const body = await readJsonBody(req, LIMITS.apiBodyBytes);
      const patch: UpdateLinkInput = {
        ...(body.label !== undefined ? { label: v.str(body, "label", { max: 140 }) ?? "" } : {}),
        ...(body.downloadFilename !== undefined
          ? { downloadFilename: v.str(body, "downloadFilename", { min: 1, max: 256 })! }
          : {}),
        ...(body.notes !== undefined ? { notes: v.str(body, "notes", { optional: true, max: 1000 }) ?? "" } : {}),
        ...(body.expiryMode !== undefined
          ? { expiryMode: v.str(body, "expiryMode") as UpdateLinkInput["expiryMode"] }
          : {}),
        ...(body.idleTtlSec !== undefined
          ? { idleTtlSec: body.idleTtlSec === null ? null : v.int(body, "idleTtlSec", { min: 60, max: 365 * 24 * 3600 }) }
          : {}),
        ...(body.expiresAt !== undefined
          ? { expiresAt: body.expiresAt === null ? null : v.int(body, "expiresAt", { min: 1 }) }
          : {}),
        ...(body.hardExpiresAt !== undefined
          ? { hardExpiresAt: body.hardExpiresAt === null ? null : v.int(body, "hardExpiresAt", { min: 1 }) }
          : {}),
        ...(body.startedIpCanResume !== undefined
          ? { startedIpCanResume: v.bool(body, "startedIpCanResume") }
          : {}),
        ...(body.resumeGraceSec !== undefined
          ? { resumeGraceSec: v.int(body, "resumeGraceSec", { min: 0, max: 365 * 24 * 3600 })! }
          : {}),
        ...(body.lockToFirstIp !== undefined ? { lockToFirstIp: v.bool(body, "lockToFirstIp") } : {}),
        ...(body.ipWhitelist !== undefined ? { ipWhitelist: body.ipWhitelist as string[] | string } : {}),
        ...(body.maxDownloads !== undefined
          ? { maxDownloads: body.maxDownloads === null ? null : v.int(body, "maxDownloads", { min: 1, max: 1_000_000 }) }
          : {}),
        ...(body.password !== undefined ? { password: v.str(body, "password", { optional: true, max: 256 }) } : {}),
        ...(body.clearPassword !== undefined ? { clearPassword: v.bool(body, "clearPassword") } : {}),
        ...(body.allowInline !== undefined ? { allowInline: v.bool(body, "allowInline") } : {}),
        ...(body.autoDeleteFile !== undefined ? { autoDeleteFile: v.bool(body, "autoDeleteFile") } : {}),
        ...(body.maxSpeedKbps !== undefined
          ? { maxSpeedKbps: body.maxSpeedKbps === null ? null : v.int(body, "maxSpeedKbps", { min: 1, max: 10_000_000 }) }
          : {}),
        ...(body.status !== undefined ? { status: v.str(body, "status") as "active" | "paused" } : {}),
      };
      const link = await updateLink(id, patch, baseUrl, ip);
      return ok({ link }, req);
    }

    if (req.method === "DELETE") {
      deleteLink(id, ip);
      return ok({}, req);
    }
  }

  // Activity feed (download events + admin audit log)
  if (reqPath === "/api/activity" && req.method === "GET") {
    await requireAdmin(req);
    const kind = url.searchParams.get("kind") || "downloads";
    const outcome = (url.searchParams.get("outcome") || "").trim();
    const limit = Math.min(300, Math.max(1, Number(url.searchParams.get("limit") || 100)));

    if (kind === "audit") {
      const rows = db
        .query<AuditLogRow, [number]>("SELECT * FROM audit_log ORDER BY ts DESC LIMIT ?")
        .all(limit);
      return ok(
        {
          audit: rows.map((r) => ({
            id: r.id,
            ts: r.ts,
            action: r.action,
            target: r.target,
            meta: r.meta ? JSON.parse(r.meta) : null,
            ip: r.ip,
          })),
        },
        req,
      );
    }

    const where = outcome ? "WHERE e.outcome = ?" : "";
    const params = outcome ? [outcome, limit] : [limit];
    const events = db
      .query<
        {
          id: number;
          link_id: string;
          label: string | null;
          download_filename: string | null;
          token: string | null;
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
        },
        any[]
      >(
        `SELECT e.id, e.link_id, l.label, l.download_filename, l.token, e.ts, e.ip, e.user_agent,
                e.method, e.range_start, e.range_end, e.bytes_sent, e.status, e.outcome, e.duration_ms
         FROM download_events e
         LEFT JOIN links l ON l.id = e.link_id
         ${where}
         ORDER BY e.ts DESC LIMIT ?`,
      )
      .all(...params);

    return ok(
      {
        events: events.map((e) => ({
          id: e.id,
          linkId: e.link_id,
          label: e.label ?? "Deleted link",
          filename: e.download_filename ?? "",
          token: e.token ?? "",
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
      },
      req,
    );
  }

  // Settings
  if (reqPath === "/api/settings" && req.method === "GET") {
    await requireAdmin(req);
    const dbBaseOverride = getSetting("base_url_override") || "";
    const effectiveBase = getEffectivePublicBaseUrl(req);
    const parsedEffective = parseBaseUrl(effectiveBase);
    return ok(
      {
        clientIp: ip,
        envBaseUrlLocked: ENV_BASE_URL_SET,
        envBaseUrl: PUBLIC_BASE_URL,
        baseUrlOverride: dbBaseOverride,
        effectiveBaseUrl: effectiveBase,
        effectiveBasePath: BASE_PATH || parsedEffective.basePath,
        trustProxy: TRUST_PROXY,
        filesDir: FILES_DIR,
        mount: mountStatus(),
        chunkMaxBytes: UPLOAD_CHUNK_MAX_BYTES,
        defaultPolicy: getDefaultPolicy(),
      },
      req,
    );
  }

  if (reqPath === "/api/settings" && req.method === "PATCH") {
    await requireAdmin(req);
    const body = await readJsonBody(req, LIMITS.apiBodyBytes);
    if (body.baseUrlOverride !== undefined && !ENV_BASE_URL_SET) {
      const raw = typeof body.baseUrlOverride === "string" ? body.baseUrlOverride.trim() : "";
      if (!raw) {
        setSetting("base_url_override", null);
      } else {
        const parsed = parseBaseUrl(raw);
        setSetting("base_url_override", parsed.publicBaseUrl);
      }
      audit("settings.base_url", { meta: { baseUrlOverride: raw || null }, ip });
    }
    if (body.defaultPolicy && typeof body.defaultPolicy === "object") {
      saveDefaultPolicy(body.defaultPolicy as Record<string, unknown>, ip);
    }
    return ok(
      {
        effectiveBaseUrl: getEffectivePublicBaseUrl(req),
        baseUrlOverride: getSetting("base_url_override") || "",
        defaultPolicy: getDefaultPolicy(),
      },
      req,
    );
  }

  return null;
}
