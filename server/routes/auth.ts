import {
  beginTotpSetup,
  changeAdminPassword,
  confirmTotpSetup,
  disableTotp,
  getAdminAccount,
  issueInitialSession,
  listSessions,
  loginAdmin,
  needsSetup,
  publicAdmin,
  requireAdmin,
  revokeSession,
  rotateRefreshToken,
  setupAdmin,
  verifyAdmin2fa,
} from "../auth";
import { LIMITS } from "../config";
import { audit } from "../db";
import { ApiError, clientIp, ok, rateLimitError, readJsonBody, v } from "../http";
import { limits } from "../ratelimit";

export async function handleAuthRoute(path: string, req: Request, server?: any): Promise<Response | null> {
  const ip = clientIp(req, server);
  const ua = req.headers.get("user-agent");

  if (path === "/api/auth/status" && req.method === "GET") {
    const admin = getAdminAccount();
    return ok({ needsSetup: !admin, username: admin?.username ?? null }, req);
  }

  if (path === "/api/auth/setup" && req.method === "POST") {
    const retry = limits.authPerMin(ip);
    if (retry > 0) return rateLimitError(`rate limit exceeded, retry in ${retry}s`, retry, req);
    const body = await readJsonBody(req, LIMITS.authBodyBytes);
    const username = v.str(body, "username", { min: 2, max: 64 })!;
    const password = v.str(body, "password", { min: 8, max: 256 })!;
    await setupAdmin(username, password, ip);
    const session = await issueInitialSession({ ip, ua });
    return ok(session, req);
  }

  if (path === "/api/auth/login" && req.method === "POST") {
    const retry = limits.authPerMin(ip);
    if (retry > 0) return rateLimitError(`rate limit exceeded, retry in ${retry}s`, retry, req);
    const body = await readJsonBody(req, LIMITS.authBodyBytes);
    const username = v.str(body, "username", { min: 1, max: 64 })!;
    const password = v.str(body, "password", { min: 1, max: 256 })!;
    if (needsSetup()) {
      throw new ApiError(400, "Admin account has not been set up yet", "setup_required");
    }
    const result = await loginAdmin(username, password, { ip, ua });
    return ok(result, req);
  }

  if (path === "/api/auth/2fa" && req.method === "POST") {
    const retry = limits.authPerMin(ip);
    if (retry > 0) return rateLimitError(`rate limit exceeded, retry in ${retry}s`, retry, req);
    const body = await readJsonBody(req, LIMITS.authBodyBytes);
    const tempToken = v.str(body, "tempToken", { min: 16, max: 2048 })!;
    const code = v.str(body, "code", { min: 6, max: 16 })!;
    const result = await verifyAdmin2fa(tempToken, code, { ip, ua });
    return ok(result, req);
  }

  if (path === "/api/auth/refresh" && req.method === "POST") {
    const body = await readJsonBody(req, LIMITS.authBodyBytes);
    const refreshToken = v.str(body, "refreshToken", { min: 16, max: 512 })!;
    const result = await rotateRefreshToken(refreshToken, { ip, ua });
    return ok(result, req);
  }

  if (path === "/api/auth/logout" && req.method === "POST") {
    const { session } = await requireAdmin(req);
    revokeSession(session.jti);
    audit("admin.logout", { target: session.jti, ip });
    return ok({}, req);
  }

  if (path === "/api/account" && req.method === "GET") {
    const { admin } = await requireAdmin(req);
    return ok({ admin: publicAdmin(admin) }, req);
  }

  if (path === "/api/account/password" && req.method === "POST") {
    const { admin, session } = await requireAdmin(req);
    const body = await readJsonBody(req, LIMITS.authBodyBytes);
    const currentPassword = v.str(body, "currentPassword", { min: 1, max: 256 })!;
    const newPassword = v.str(body, "newPassword", { min: 8, max: 256 })!;
    await changeAdminPassword(admin, currentPassword, newPassword, session.jti, ip);
    return ok({}, req);
  }

  if (path === "/api/account/sessions" && req.method === "GET") {
    const { session } = await requireAdmin(req);
    return ok({ sessions: listSessions(session.jti) }, req);
  }

  const sessMatch = path.match(/^\/api\/account\/sessions\/([a-f0-9]+)$/);
  if (sessMatch && req.method === "DELETE") {
    await requireAdmin(req);
    revokeSession(sessMatch[1]!);
    audit("session.revoked", { target: sessMatch[1]!, ip });
    return ok({}, req);
  }

  if (path === "/api/account/totp/setup" && req.method === "POST") {
    const { admin } = await requireAdmin(req);
    const data = beginTotpSetup(admin);
    return ok(data, req);
  }

  if (path === "/api/account/totp/confirm" && req.method === "POST") {
    const { admin } = await requireAdmin(req);
    const body = await readJsonBody(req, LIMITS.authBodyBytes);
    const code = v.str(body, "code", { min: 6, max: 16 })!;
    await confirmTotpSetup(admin, code, ip);
    return ok({ totpEnabled: true }, req);
  }

  if (path === "/api/account/totp" && req.method === "DELETE") {
    const { admin } = await requireAdmin(req);
    const body = await readJsonBody(req, LIMITS.authBodyBytes);
    const password = v.str(body, "password", { min: 1, max: 256 })!;
    await disableTotp(admin, password, ip);
    return ok({ totpEnabled: false }, req);
  }

  return null;
}
