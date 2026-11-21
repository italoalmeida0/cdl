/**
 * Cryptographic helpers built on WebCrypto and Bun.CryptoHasher (zero external deps):
 * - PBKDF2-SHA256 password hashing (100k iterations, constant-time verify)
 * - RFC 6238 TOTP secrets, verification, and otpauth URI
 * - HS256 JWT access & 2FA challenge tokens
 * - HMAC-SHA256 signed password-unlock cookies for browser direct downloads
 */

const te = new TextEncoder();
const td = new TextDecoder();

export function randomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}

export function randomToken(n = 32): string {
  return Buffer.from(randomBytes(n)).toString("hex");
}

export function randomBase64UrlToken(bytes = 18): string {
  return b64uEncode(randomBytes(bytes));
}

export function sha256Hex(data: string | Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(data as string).digest("hex");
}

export function b64uEncode(buf: ArrayBuffer | Uint8Array): string {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  return Buffer.from(b).toString("base64url");
}

export function b64uDecode(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, "base64url"));
}

export function b64Encode(buf: Uint8Array): string {
  return Buffer.from(buf).toString("base64");
}

export function b64Decode(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, "base64"));
}

export function timingSafeEq(a: string | Uint8Array, b: string | Uint8Array): boolean {
  const ba = typeof a === "string" ? te.encode(a) : a;
  const bb = typeof b === "string" ? te.encode(b) : b;
  if (ba.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ba.length; i++) diff |= ba[i]! ^ bb[i]!;
  return diff === 0;
}

async function deriveKey(label: string, secret: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-256", te.encode(`${label}:${secret}`));
  return new Uint8Array(digest);
}

// ===== PBKDF2 passwords =====

const PBKDF2_ITERATIONS = 100_000;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(32);
  const key = await crypto.subtle.importKey("raw", te.encode(password), "PBKDF2", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: salt as BufferSource, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    key,
    256,
  );
  return `pbkdf2:${PBKDF2_ITERATIONS}:${b64Encode(salt)}:${b64Encode(new Uint8Array(bits))}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split(":");
  if (parts.length !== 4 || parts[0] !== "pbkdf2") return false;
  const iterations = Number(parts[1]);
  if (!Number.isInteger(iterations) || iterations < 10_000 || iterations > 2_000_000) return false;
  const salt = b64Decode(parts[2]!);
  const expected = b64Decode(parts[3]!);
  const key = await crypto.subtle.importKey("raw", te.encode(password), "PBKDF2", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: salt as BufferSource, iterations, hash: "SHA-256" },
    key,
    expected.length * 8,
  );
  return timingSafeEq(new Uint8Array(bits), expected);
}

// ===== TOTP (RFC 6238) =====

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buf: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Uint8Array {
  const clean = s.toUpperCase().replace(/=+$/, "").replace(/\s/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error("invalid base32");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

export function newTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

async function hotp(secretBytes: Uint8Array, counter: number): Promise<string> {
  const msg = new ArrayBuffer(8);
  new DataView(msg).setUint32(4, counter, false);
  const key = await crypto.subtle.importKey(
    "raw",
    secretBytes as BufferSource,
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, msg));
  const offset = sig[sig.length - 1]! & 0x0f;
  const code =
    ((sig[offset]! & 0x7f) << 24) |
    ((sig[offset + 1]! & 0xff) << 16) |
    ((sig[offset + 2]! & 0xff) << 8) |
    (sig[offset + 3]! & 0xff);
  return String(code % 1_000_000).padStart(6, "0");
}

export async function totpAt(secret: string, timestampMs: number): Promise<string> {
  return hotp(base32Decode(secret), Math.floor(timestampMs / 1000 / 30));
}

export async function totpVerify(secret: string, code: string, timestampMs = Date.now()): Promise<boolean> {
  const counter = Math.floor(timestampMs / 1000 / 30);
  const secretBytes = base32Decode(secret);
  let ok = false;
  for (const delta of [-1, 0, 1]) {
    const expected = await hotp(secretBytes, counter + delta);
    if (timingSafeEq(expected, code)) ok = true;
  }
  return ok;
}

export function totpUri(secret: string, username: string, issuer = "CDL"): string {
  return (
    `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(username)}` +
    `?secret=${secret}&issuer=${encodeURIComponent(issuer)}&digits=6&period=30`
  );
}

// ===== JWT HS256 =====

export interface JwtPayload {
  sub: string;
  jti: string;
  type: "access" | "2fa";
  iat: number;
  exp: number;
  [k: string]: unknown;
}

export type JwtVerifyResult =
  | { ok: true; payload: JwtPayload }
  | { ok: false; reason: "malformed" | "signature" | "expired" };

const hmacKeyCache = new Map<string, Promise<CryptoKey>>();

async function hsKey(label: string, secret: string): Promise<CryptoKey> {
  const cacheKey = `${label}:${secret}`;
  let p = hmacKeyCache.get(cacheKey);
  if (!p) {
    p = deriveKey(label, secret).then((raw) =>
      crypto.subtle.importKey("raw", raw as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, [
        "sign",
        "verify",
      ]),
    );
    hmacKeyCache.set(cacheKey, p);
  }
  return p;
}

export async function jwtSign(
  claims: Omit<JwtPayload, "iat" | "exp">,
  secret: string,
  ttlSec: number,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const payload = { ...claims, iat: now, exp: now + ttlSec } as JwtPayload;
  const head = b64uEncode(te.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const body = b64uEncode(te.encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign("HMAC", await hsKey("jwt-hs256", secret), te.encode(`${head}.${body}`));
  return `${head}.${body}.${b64uEncode(sig)}`;
}

export async function jwtVerify(token: string, secret: string): Promise<JwtVerifyResult> {
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed" };
  const [head, body, sig] = parts as [string, string, string];
  const expected = await crypto.subtle.sign("HMAC", await hsKey("jwt-hs256", secret), te.encode(`${head}.${body}`));
  let sigBytes: Uint8Array;
  try {
    sigBytes = b64uDecode(sig);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (!timingSafeEq(new Uint8Array(expected), sigBytes)) return { ok: false, reason: "signature" };

  let payload: JwtPayload;
  try {
    payload = JSON.parse(td.decode(b64uDecode(body)));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (typeof payload.exp !== "number" || payload.exp < Math.floor(Date.now() / 1000)) {
    return { ok: false, reason: "expired" };
  }
  return { ok: true, payload };
}

// ===== Link unlock cookie =====

export async function signUnlockCookie(
  linkId: string,
  passwordHash: string,
  secret: string,
  ttlSec = 12 * 3600,
): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + ttlSec;
  const pwDigest = sha256Hex(passwordHash).slice(0, 16);
  const payload = b64uEncode(te.encode(JSON.stringify({ linkId, exp, pw: pwDigest })));
  const sig = await crypto.subtle.sign("HMAC", await hsKey("link-unlock", secret), te.encode(payload));
  return `${payload}.${b64uEncode(sig)}`;
}

export async function verifyUnlockCookie(
  cookieValue: string,
  linkId: string,
  passwordHash: string,
  secret: string,
): Promise<boolean> {
  const parts = cookieValue.split(".");
  if (parts.length !== 2) return false;
  const [payload, sig] = parts as [string, string];
  let sigBytes: Uint8Array;
  try {
    sigBytes = b64uDecode(sig);
  } catch {
    return false;
  }
  const expected = await crypto.subtle.sign("HMAC", await hsKey("link-unlock", secret), te.encode(payload));
  if (!timingSafeEq(new Uint8Array(expected), sigBytes)) return false;

  try {
    const decoded = JSON.parse(td.decode(b64uDecode(payload))) as {
      linkId?: string;
      exp?: number;
      pw?: string;
    };
    if (decoded.linkId !== linkId) return false;
    if (typeof decoded.exp !== "number" || decoded.exp < Math.floor(Date.now() / 1000)) return false;
    const expectedPwDigest = sha256Hex(passwordHash).slice(0, 16);
    return decoded.pw === expectedPwDigest;
  } catch {
    return false;
  }
}
