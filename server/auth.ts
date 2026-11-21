import { ADMIN_PASSWORD, ADMIN_USERNAME, CDL_SECRET, LIMITS } from "./config";
import {
  hashPassword,
  jwtSign,
  jwtVerify,
  newTotpSecret,
  randomToken,
  sha256Hex,
  totpUri,
  totpVerify,
  verifyPassword,
} from "./crypto";
import { audit, db, inImmediateTx, type AdminAccountRow, type SessionRow } from "./db";
import { ApiError } from "./http";
import { bruteforceClear, bruteforceFail, bruteforceLocked, consumeTotpCode } from "./ratelimit";

export interface AdminProfile {
  username: string;
  totpEnabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface AuthContext {
  admin: AdminAccountRow;
  session: SessionRow;
}

export function getAdminAccount(): AdminAccountRow | null {
  return db.query<AdminAccountRow, []>("SELECT * FROM admin_account WHERE id = 1").get() ?? null;
}

export function needsSetup(): boolean {
  return getAdminAccount() === null;
}

export function publicAdmin(admin: AdminAccountRow): AdminProfile {
  return {
    username: admin.username,
    totpEnabled: !!admin.totp_secret,
    createdAt: admin.created_at,
    updatedAt: admin.updated_at,
  };
}

export async function bootstrapAdminFromEnv(): Promise<void> {
  if (getAdminAccount()) return;
  if (!ADMIN_PASSWORD) {
    console.log("[BOOT] No admin account configured yet. Open the dashboard to complete first-time setup.");
    return;
  }
  if (ADMIN_PASSWORD.length < 8) {
    console.error("[BOOT] FATAL: ADMIN_PASSWORD must be at least 8 characters long.");
    process.exit(1);
  }
  const now = Date.now();
  const passwordHash = await hashPassword(ADMIN_PASSWORD);
  db.prepare(
    "INSERT INTO admin_account (id, username, password_hash, created_at, updated_at) VALUES (1, ?, ?, ?, ?)",
  ).run(ADMIN_USERNAME, passwordHash, now, now);
  audit("admin.bootstrapped", { target: ADMIN_USERNAME });
  console.log(`[BOOT] Single admin account "${ADMIN_USERNAME}" initialized from environment.`);
}

export async function setupAdmin(username: string, password: string, ip: string): Promise<AdminAccountRow> {
  if (!needsSetup()) {
    throw new ApiError(403, "Admin account is already configured", "already_setup");
  }
  const cleanUsername = username.trim();
  if (cleanUsername.length < 2 || cleanUsername.length > 64) {
    throw new ApiError(400, "Username must be between 2 and 64 characters");
  }
  if (password.length < 8 || password.length > 256) {
    throw new ApiError(400, "Password must be between 8 and 256 characters");
  }
  const passwordHash = await hashPassword(password);
  const now = Date.now();
  const admin = inImmediateTx(() => {
    if (getAdminAccount()) {
      throw new ApiError(403, "Admin account is already configured", "already_setup");
    }
    db.prepare(
      "INSERT INTO admin_account (id, username, password_hash, created_at, updated_at) VALUES (1, ?, ?, ?, ?)",
    ).run(cleanUsername, passwordHash, now, now);
    audit("admin.setup", { target: cleanUsername, ip });
    return getAdminAccount()!;
  });
  return admin;
}

async function createSessionTokens(
  meta: { ip?: string | null; ua?: string | null; family?: string; createdAt?: number } = {},
): Promise<{
  jti: string;
  accessToken: string;
  refreshToken: string;
  session: SessionRow;
}> {
  const jti = randomToken(16);
  const refreshToken = randomToken(32);
  const now = Date.now();
  const createdAt = meta.createdAt ?? now;
  const family = meta.family ?? jti;
  const expiresAt = now + LIMITS.refreshTokenTtlMs;
  const absExpiresAt = createdAt + LIMITS.refreshAbsoluteTtlMs;
  const accessToken = await jwtSign(
    { sub: "admin", jti, type: "access" },
    CDL_SECRET,
    LIMITS.accessTokenTtlSec,
  );
  const refreshHash = sha256Hex(refreshToken);
  db.prepare(
    `INSERT INTO sessions (jti, refresh_hash, created_at, last_used_at, expires_at, abs_expires_at, revoked, ip, ua, family)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
  ).run(
    jti,
    refreshHash,
    createdAt,
    now,
    expiresAt,
    absExpiresAt,
    meta.ip ?? null,
    meta.ua?.slice(0, 240) ?? null,
    family,
  );
  const session = db.query<SessionRow, [string]>("SELECT * FROM sessions WHERE jti = ?").get(jti)!;
  return { jti, accessToken, refreshToken, session };
}

export async function loginAdmin(
  username: string,
  password: string,
  meta: { ip: string; ua: string | null },
): Promise<
  | { needs2FA: true; tempToken: string }
  | { needs2FA: false; accessToken: string; refreshToken: string; admin: AdminProfile }
> {
  const ipScope = `login:ip:${meta.ip}`;
  const lockedSec = bruteforceLocked(ipScope);
  if (lockedSec > 0) {
    throw new ApiError(429, `Too many failed attempts. Try again in ${lockedSec}s`);
  }

  const admin = getAdminAccount();
  if (!admin) {
    throw new ApiError(400, "Initial setup is required first", "setup_required");
  }

  const usernameMatches = username.trim().toLowerCase() === admin.username.toLowerCase();
  const passwordMatches = await verifyPassword(password, admin.password_hash);
  if (!usernameMatches || !passwordMatches) {
    bruteforceFail(ipScope);
    audit("admin.login_failed", { target: username.trim(), ip: meta.ip });
    throw new ApiError(401, "Invalid username or password");
  }

  bruteforceClear(ipScope);

  if (admin.totp_secret) {
    const jti = randomToken(16);
    const tempToken = await jwtSign(
      { sub: "admin", jti, type: "2fa" },
      CDL_SECRET,
      LIMITS.twoFaTempTtlSec,
    );
    const now = Date.now();
    db.prepare("DELETE FROM auth_challenges WHERE expires_at < ?").run(now);
    db.prepare("INSERT INTO auth_challenges (id, expires_at) VALUES (?, ?)").run(
      jti,
      now + LIMITS.twoFaTempTtlSec * 1000,
    );
    return { needs2FA: true, tempToken };
  }

  const { accessToken, refreshToken } = await createSessionTokens({ ip: meta.ip, ua: meta.ua });
  audit("admin.login", { target: admin.username, ip: meta.ip });
  return {
    needs2FA: false,
    accessToken,
    refreshToken,
    admin: publicAdmin(admin),
  };
}

export async function verifyAdmin2fa(
  tempToken: string,
  code: string,
  meta: { ip: string; ua: string | null },
): Promise<{ accessToken: string; refreshToken: string; admin: AdminProfile }> {
  const ipScope = `2fa:ip:${meta.ip}`;
  const lockedSec = bruteforceLocked(ipScope);
  if (lockedSec > 0) {
    throw new ApiError(429, `Too many failed 2FA attempts. Try again in ${lockedSec}s`);
  }

  const verified = await jwtVerify(tempToken, CDL_SECRET);
  if (!verified.ok || verified.payload.type !== "2fa") {
    throw new ApiError(401, "Invalid or expired 2FA token");
  }

  const challenge = db
    .query<{ id: string; expires_at: number }, [string]>("SELECT id, expires_at FROM auth_challenges WHERE id = ?")
    .get(verified.payload.jti);
  if (!challenge || challenge.expires_at <= Date.now()) {
    throw new ApiError(401, "Invalid or expired 2FA challenge");
  }

  const admin = getAdminAccount();
  if (!admin || !admin.totp_secret) {
    throw new ApiError(401, "2FA is not configured");
  }

  const cleanCode = code.replace(/\s+/g, "");
  if (!/^\d{6}$/.test(cleanCode)) {
    bruteforceFail(ipScope);
    throw new ApiError(401, "Invalid authenticator code");
  }

  const valid = await totpVerify(admin.totp_secret, cleanCode);
  if (!valid) {
    bruteforceFail(ipScope);
    throw new ApiError(401, "Invalid authenticator code");
  }

  const replayDigest = sha256Hex(`${admin.totp_secret}:${Math.floor(Date.now() / 30_000)}:${cleanCode}`);
  if (!consumeTotpCode(replayDigest)) {
    throw new ApiError(401, "Authenticator code already used");
  }

  const deleted = db
    .prepare("DELETE FROM auth_challenges WHERE id = ? AND expires_at > ?")
    .run(verified.payload.jti, Date.now());
  if (deleted.changes !== 1) {
    throw new ApiError(401, "2FA challenge already consumed");
  }

  bruteforceClear(ipScope);
  const { accessToken, refreshToken } = await createSessionTokens({ ip: meta.ip, ua: meta.ua });
  audit("admin.login_2fa", { target: admin.username, ip: meta.ip });
  return { accessToken, refreshToken, admin: publicAdmin(admin) };
}

export async function issueInitialSession(
  meta: { ip: string; ua: string | null },
): Promise<{ accessToken: string; refreshToken: string; admin: AdminProfile }> {
  const admin = getAdminAccount();
  if (!admin) throw new ApiError(401, "Admin account missing");
  const { accessToken, refreshToken } = await createSessionTokens({ ip: meta.ip, ua: meta.ua });
  return { accessToken, refreshToken, admin: publicAdmin(admin) };
}

export async function rotateRefreshToken(
  refreshToken: string,
  meta: { ip: string; ua: string | null },
): Promise<{ accessToken: string; refreshToken: string; admin: AdminProfile }> {
  const row = db
    .query<SessionRow, [string]>("SELECT * FROM sessions WHERE refresh_hash = ?")
    .get(sha256Hex(refreshToken));
  if (!row) throw new ApiError(401, "Invalid refresh token");

  const now = Date.now();
  if (row.revoked) {
    const lapsedNaturally = row.expires_at < now || row.abs_expires_at < now;
    if (!lapsedNaturally) {
      db.prepare("UPDATE sessions SET revoked = 1 WHERE family = ?").run(row.family);
      audit("session.refresh_reuse", { target: row.jti, meta: { family: row.family }, ip: meta.ip });
    }
    throw new ApiError(401, "Session expired, please sign in again");
  }
  if (row.abs_expires_at < now || row.expires_at < now) {
    db.prepare("UPDATE sessions SET revoked = 1 WHERE jti = ?").run(row.jti);
    throw new ApiError(401, "Session expired, please sign in again");
  }

  const admin = getAdminAccount();
  if (!admin) throw new ApiError(401, "Account unavailable");

  const next = inImmediateTx(() => {
    const current = db.query<SessionRow, [string]>("SELECT * FROM sessions WHERE jti = ?").get(row.jti);
    if (!current || current.revoked) throw new ApiError(401, "Session revoked");
    db.prepare("UPDATE sessions SET revoked = 1 WHERE jti = ?").run(row.jti);
    return current;
  });

  const issued = await createSessionTokens({
    ip: meta.ip,
    ua: meta.ua ?? next.ua,
    family: next.family,
    createdAt: next.created_at,
  });
  return {
    accessToken: issued.accessToken,
    refreshToken: issued.refreshToken,
    admin: publicAdmin(admin),
  };
}

export async function requireAdmin(req: Request): Promise<AuthContext> {
  const header = req.headers.get("authorization") || "";
  if (!header.toLowerCase().startsWith("bearer ")) {
    throw new ApiError(401, "Authentication required");
  }
  const token = header.slice(7).trim();
  if (!token) throw new ApiError(401, "Authentication required");

  const verified = await jwtVerify(token, CDL_SECRET);
  if (!verified.ok || verified.payload.type !== "access" || verified.payload.sub !== "admin") {
    throw new ApiError(401, "Invalid or expired session token");
  }

  const session = db
    .query<SessionRow, [string]>("SELECT * FROM sessions WHERE jti = ?")
    .get(verified.payload.jti);
  const now = Date.now();
  if (!session || session.revoked || session.abs_expires_at < now || session.expires_at < now) {
    throw new ApiError(401, "Session has expired or been revoked");
  }

  const admin = getAdminAccount();
  if (!admin) throw new ApiError(401, "Admin account not found");

  if (now - session.last_used_at > 60_000) {
    db.prepare("UPDATE sessions SET last_used_at = ? WHERE jti = ?").run(now, session.jti);
  }
  return { admin, session };
}

export function revokeSession(jti: string): void {
  db.prepare("UPDATE sessions SET revoked = 1 WHERE jti = ?").run(jti);
}

export function listSessions(currentJti: string) {
  const now = Date.now();
  const rows = db
    .query<SessionRow, [number, number]>(
      "SELECT * FROM sessions WHERE revoked = 0 AND abs_expires_at > ? AND expires_at > ? ORDER BY last_used_at DESC",
    )
    .all(now, now);
  return rows.map((s) => ({
    jti: s.jti,
    createdAt: s.created_at,
    lastUsedAt: s.last_used_at,
    expiresAt: s.expires_at,
    ip: s.ip,
    ua: s.ua,
    current: s.jti === currentJti,
  }));
}

export async function changeAdminPassword(
  admin: AdminAccountRow,
  currentPassword: string,
  newPassword: string,
  currentJti: string,
  ip: string,
): Promise<void> {
  const valid = await verifyPassword(currentPassword, admin.password_hash);
  if (!valid) throw new ApiError(400, "Current password is incorrect");
  if (newPassword.length < 8 || newPassword.length > 256) {
    throw new ApiError(400, "New password must be between 8 and 256 characters");
  }
  const hash = await hashPassword(newPassword);
  const now = Date.now();
  inImmediateTx(() => {
    db.prepare("UPDATE admin_account SET password_hash = ?, updated_at = ? WHERE id = 1").run(hash, now);
    db.prepare("UPDATE sessions SET revoked = 1 WHERE jti != ?").run(currentJti);
    audit("admin.password_changed", { ip });
  });
}

export function beginTotpSetup(admin: AdminAccountRow): { secret: string; uri: string } {
  if (admin.totp_secret) {
    throw new ApiError(400, "2FA is already enabled");
  }
  const secret = newTotpSecret();
  db.prepare("UPDATE admin_account SET totp_pending = ?, updated_at = ? WHERE id = 1").run(secret, Date.now());
  return { secret, uri: totpUri(secret, admin.username, "CDL") };
}

export async function confirmTotpSetup(admin: AdminAccountRow, code: string, ip: string): Promise<void> {
  if (!admin.totp_pending) throw new ApiError(400, "No pending 2FA setup");
  const cleanCode = code.replace(/\s+/g, "");
  if (!/^\d{6}$/.test(cleanCode) || !(await totpVerify(admin.totp_pending, cleanCode))) {
    throw new ApiError(400, "Invalid verification code");
  }
  db.prepare("UPDATE admin_account SET totp_secret = ?, totp_pending = NULL, updated_at = ? WHERE id = 1").run(
    admin.totp_pending,
    Date.now(),
  );
  audit("admin.totp_enabled", { ip });
}

export async function disableTotp(admin: AdminAccountRow, password: string, ip: string): Promise<void> {
  if (!admin.totp_secret) throw new ApiError(400, "2FA is not enabled");
  if (!(await verifyPassword(password, admin.password_hash))) {
    throw new ApiError(400, "Invalid password");
  }
  db.prepare("UPDATE admin_account SET totp_secret = NULL, totp_pending = NULL, updated_at = ? WHERE id = 1").run(
    Date.now(),
  );
  audit("admin.totp_disabled", { ip });
}
