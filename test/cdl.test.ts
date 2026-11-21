import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "fs";
import os from "os";
import path from "path";

const tempRoot = mkdtempSync(path.join(os.tmpdir(), "cdl-test-"));
const testDataDir = path.join(tempRoot, "data");
const testFilesDir = path.join(tempRoot, "files");
const outsideFile = path.join(tempRoot, "secret-outside.txt");
mkdirSync(testDataDir, { recursive: true });
mkdirSync(path.join(testFilesDir, "movies"), { recursive: true });

// Sample files in mounted folder
const sampleContent = Buffer.alloc(16 * 1024);
for (let i = 0; i < sampleContent.length; i++) sampleContent[i] = (i * 31 + 7) & 0xff;
writeFileSync(path.join(testFilesDir, "sample-archive.bin"), sampleContent);
writeFileSync(path.join(testFilesDir, "movies", "clássico ação.txt"), "Olá CDL UTF-8 filename!");
writeFileSync(outsideFile, "TOP_SECRET_OUTSIDE");
try {
  symlinkSync(outsideFile, path.join(testFilesDir, "escape-link.txt"));
} catch {
  // Symlink creation on unprivileged Windows may be disabled; guard handled in test.
}

process.env.NODE_ENV = "test";
process.env.DATA_DIR = testDataDir;
process.env.FILES_DIR = testFilesDir;
process.env.TRUST_PROXY = "true";
process.env.TRUSTED_PROXY_CIDRS = "127.0.0.1/8,10.0.0.0/8,::1/128";
process.env.BASE_URL = "https://example.com/lalala/";
delete process.env.ADMIN_PASSWORD;

const { route, createHttpServer } = await import("../server/index");
const { db } = await import("../server/db");
const { totpAt } = await import("../server/crypto");
const { sweepMaintenance, refreshLinkActivity, computeEffectiveStatus } = await import("../server/links");
const { registerTransfer, finishTransfer } = await import("../server/transfers");
const { parseBaseUrl } = await import("../server/config");

const fakeServer = (peerIp = "127.0.0.1") => ({
  requestIP: () => ({ address: peerIp }),
  timeout: () => {},
});

async function call(
  method: string,
  reqPath: string,
  opts: {
    body?: unknown;
    rawBody?: BodyInit;
    headers?: Record<string, string>;
    token?: string;
    ip?: string;
    peerIp?: string;
  } = {},
): Promise<Response> {
  const headers = new Headers(opts.headers);
  if (opts.token) headers.set("Authorization", `Bearer ${opts.token}`);
  if (opts.ip) headers.set("X-Forwarded-For", opts.ip);
  let body: BodyInit | undefined = opts.rawBody;
  if (opts.body !== undefined) {
    headers.set("Content-Type", "application/json");
    body = JSON.stringify(opts.body);
  }
  const url = `http://localhost${reqPath.startsWith("/") ? reqPath : `/${reqPath}`}`;
  return route(new Request(url, { method, headers, body }), fakeServer(opts.peerIp ?? "127.0.0.1"));
}

afterAll(() => {
  try {
    db.close(false);
  } catch {}
  try {
    rmSync(tempRoot, { recursive: true, force: true });
  } catch {}
});

describe("CDL Core Suite", () => {
  let accessToken = "";
  let refreshToken = "";
  let sampleLinkId = "";
  let sampleLinkToken = "";

  test("1. parseBaseUrl normalizes subpath & origin cleanly", () => {
    expect(parseBaseUrl("https://example.com/lalala/")).toEqual({
      raw: "https://example.com/lalala/",
      origin: "https://example.com",
      basePath: "/lalala",
      publicBaseUrl: "https://example.com/lalala",
    });
    expect(parseBaseUrl("/sub/path///")).toEqual({
      raw: "/sub/path///",
      origin: "",
      basePath: "/sub/path",
      publicBaseUrl: "/sub/path",
    });
  });

  test("2. Single-admin setup, lock against second setup, login, refresh rotation & reuse detection, TOTP 2FA", async () => {
    const status0 = await (await call("GET", "/api/auth/status")).json();
    expect(status0.needsSetup).toBe(true);

    const setupRes = await call("POST", "/api/auth/setup", {
      body: { username: "italo", password: "SuperStrongPassword1!" },
    });
    expect(setupRes.status).toBe(200);
    const setupJson = await setupRes.json();
    expect(setupJson.success).toBe(true);
    expect(setupJson.admin.username).toBe("italo");

    // Second setup must be rejected permanently
    const secondSetup = await call("POST", "/api/auth/setup", {
      body: { username: "hacker", password: "AnotherPassword123!" },
    });
    expect(secondSetup.status).toBe(403);

    // Login
    const loginRes = await call("POST", "/api/auth/login", {
      body: { username: "italo", password: "SuperStrongPassword1!" },
    });
    expect(loginRes.status).toBe(200);
    const loginJson = await loginRes.json();
    accessToken = loginJson.accessToken;
    refreshToken = loginJson.refreshToken;
    expect(typeof accessToken).toBe("string");

    // Refresh rotation
    const rotRes = await call("POST", "/api/auth/refresh", {
      body: { refreshToken },
    });
    expect(rotRes.status).toBe(200);
    const rotJson = await rotRes.json();
    const rotatedAccess = rotJson.accessToken;
    const rotatedRefresh = rotJson.refreshToken;
    expect(rotatedRefresh).not.toBe(refreshToken);

    // Replay of old refresh token revokes whole family!
    const replayRes = await call("POST", "/api/auth/refresh", {
      body: { refreshToken },
    });
    expect(replayRes.status).toBe(401);

    const afterReuse = await call("GET", "/api/account", { token: rotatedAccess });
    expect(afterReuse.status).toBe(401);

    // Fresh login
    const relogin = await (
      await call("POST", "/api/auth/login", {
        body: { username: "italo", password: "SuperStrongPassword1!" },
      })
    ).json();
    accessToken = relogin.accessToken;
    refreshToken = relogin.refreshToken;

    // Enable TOTP 2FA -> verify 2FA login -> disable TOTP
    const totpInit = await (await call("POST", "/api/account/totp/setup", { token: accessToken, body: {} })).json();
    const validCode = await totpAt(totpInit.secret, Date.now());
    const confirmRes = await call("POST", "/api/account/totp/confirm", {
      token: accessToken,
      body: { code: validCode },
    });
    expect(confirmRes.status).toBe(200);

    const login2faRes = await (
      await call("POST", "/api/auth/login", {
        body: { username: "italo", password: "SuperStrongPassword1!" },
      })
    ).json();
    expect(login2faRes.needs2FA).toBe(true);

    // Use a code from previous/current window? Need unused code in next step if same 30s bucket
    const nextWindowCode = await totpAt(totpInit.secret, Date.now() + 30_000);
    const finish2fa = await call("POST", "/api/auth/2fa", {
      body: { tempToken: login2faRes.tempToken, code: nextWindowCode },
    });
    expect(finish2fa.status).toBe(200);
    const finishJson = await finish2fa.json();
    accessToken = finishJson.accessToken;

    const disableRes = await call("DELETE", "/api/account/totp", {
      token: accessToken,
      body: { password: "SuperStrongPassword1!" },
    });
    expect(disableRes.status).toBe(200);
  });

  test("3. Mounted folder browsing, traversal/symlink confinement, and SHA-256 caching", async () => {
    const listRoot = await (await call("GET", "/api/files", { token: accessToken })).json();
    expect(listRoot.mount.available).toBe(true);
    const names = listRoot.entries.map((e: any) => e.name);
    expect(names).toContain("sample-archive.bin");
    expect(names).toContain("movies");

    // Traversal rejected (path.includes("..") check in router returns 400; resolveMountedPath returns 403)
    const travRes = await call("GET", "/api/files?path=..%2F..%2Fetc", { token: accessToken });
    expect([400, 403]).toContain(travRes.status);

    // Symlink escape rejected
    if (existsSync(path.join(testFilesDir, "escape-link.txt"))) {
      const symCreate = await call("POST", "/api/links", {
        token: accessToken,
        body: { sourceType: "mount", sourcePath: "escape-link.txt" },
      });
      expect(symCreate.status).toBe(403);
    }

    // Checksum compute + cache hit
    const hash1 = await (
      await call("POST", "/api/files/checksum", {
        token: accessToken,
        body: { sourceType: "mount", sourcePath: "sample-archive.bin" },
      })
    ).json();
    expect(hash1.cached).toBe(false);
    expect(hash1.sha256).toHaveLength(64);

    const hash2 = await (
      await call("POST", "/api/files/checksum", {
        token: accessToken,
        body: { sourceType: "mount", sourcePath: "sample-archive.bin" },
      })
    ).json();
    expect(hash2.cached).toBe(true);
    expect(hash2.sha256).toBe(hash1.sha256);
  });

  test("4. Subpath routing (/lalala/* and stripped /*), dynamic index.html base & strict CSP", async () => {
    // Subpath without trailing slash -> 302
    const redirectRes = await call("GET", "/lalala");
    expect(redirectRes.status).toBe(302);
    expect(redirectRes.headers.get("location")).toBe("/lalala/");

    // Built SPA under /lalala/
    const htmlRes = await call("GET", "/lalala/");
    expect(htmlRes.status).toBe(200);
    const html = await htmlRes.text();
    expect(html).toContain('<meta name="cdl-base" content="/lalala" />');
    expect(html).toContain("/lalala/assets/");
    const csp = htmlRes.headers.get("content-security-policy") || "";
    expect(csp).toContain("script-src 'self' 'sha256-");
    expect(csp).not.toContain("script-src 'self' 'unsafe-inline'");

    // Health works both at /lalala/api/health and /api/health
    expect((await call("GET", "/lalala/api/health")).status).toBe(200);
    expect((await call("GET", "/api/health")).status).toBe(200);
  });

  test("5. Direct download (200, HEAD, Range 206, suffix Range, 416, If-Range, UTF-8 Content-Disposition, X-Checksum-SHA256)", async () => {
    const createRes = await call("POST", "/api/links", {
      token: accessToken,
      body: {
        sourceType: "mount",
        sourcePath: "sample-archive.bin",
        expiryMode: "sliding",
        idleTtlSec: 10800,
      },
    });
    expect(createRes.status).toBe(200);
    const created = (await createRes.json()).link;
    sampleLinkId = created.id;
    sampleLinkToken = created.token;
    expect(created.publicUrl).toStartWith("https://example.com/lalala/d/");

    // Ensure SHA-256 is cached first so X-Checksum-SHA256 header is verified
    await call("POST", "/api/files/checksum", {
      token: accessToken,
      body: { sourceType: "mount", sourcePath: "sample-archive.bin" },
    });

    // HEAD does not count downloads
    const headRes = await call("HEAD", `/lalala/d/${sampleLinkToken}/sample-archive.bin`, { ip: "198.51.100.10" });
    expect(headRes.status).toBe(200);
    expect(headRes.headers.get("accept-ranges")).toBe("bytes");
    expect(headRes.headers.get("content-length")).toBe(String(sampleContent.length));
    expect(headRes.headers.get("x-checksum-sha256")).toHaveLength(64);
    expect(headRes.headers.get("content-disposition")).toContain("attachment;");

    const afterHead = (await (await call("GET", `/api/links/${sampleLinkId}`, { token: accessToken })).json()).link;
    expect(afterHead.downloadCount).toBe(0);

    // Full download under /lalala/d/...
    const fullRes = await call("GET", `/lalala/d/${sampleLinkToken}/sample-archive.bin`, { ip: "198.51.100.10" });
    expect(fullRes.status).toBe(200);
    const fullBuf = Buffer.from(await fullRes.arrayBuffer());
    expect(fullBuf.equals(sampleContent)).toBe(true);

    // Stripped prefix /d/... also works
    const rangeRes = await call("GET", `/d/${sampleLinkToken}/sample-archive.bin`, {
      ip: "198.51.100.10",
      headers: { Range: "bytes=100-199" },
    });
    expect(rangeRes.status).toBe(206);
    expect(rangeRes.headers.get("content-range")).toBe(`bytes 100-199/${sampleContent.length}`);
    const rangeBuf = Buffer.from(await rangeRes.arrayBuffer());
    expect(rangeBuf.equals(sampleContent.subarray(100, 200))).toBe(true);

    // Suffix range
    const suffixRes = await call("GET", `/d/${sampleLinkToken}`, {
      ip: "198.51.100.10",
      headers: { Range: "bytes=-50" },
    });
    expect(suffixRes.status).toBe(206);
    expect(Buffer.from(await suffixRes.arrayBuffer()).equals(sampleContent.subarray(-50))).toBe(true);

    // 416 Out of range
    const badRange = await call("GET", `/d/${sampleLinkToken}`, {
      ip: "198.51.100.10",
      headers: { Range: `bytes=${sampleContent.length + 100}-` },
    });
    expect(badRange.status).toBe(416);

    // If-Range mismatch -> 200 full file
    const ifRangeMismatch = await call("GET", `/d/${sampleLinkToken}`, {
      ip: "198.51.100.10",
      headers: { Range: "bytes=0-9", "If-Range": '"deadbeef"' },
    });
    expect(ifRangeMismatch.status).toBe(200);
    expect((await ifRangeMismatch.arrayBuffer()).byteLength).toBe(sampleContent.length);

    // UTF-8 Content-Disposition
    const utfCreate = await (
      await call("POST", "/api/links", {
        token: accessToken,
        body: { sourceType: "mount", sourcePath: "movies/clássico ação.txt", expiryMode: "never" },
      })
    ).json();
    const utfDl = await call("GET", `/d/${utfCreate.link.token}`, { ip: "198.51.100.10" });
    expect(utfDl.status).toBe(200);
    expect(utfDl.headers.get("content-disposition")).toContain("filename*=UTF-8''cl%C3%A1ssico%20a%C3%A7%C3%A3o.txt");
  });

  test("6. Sliding debounce expiration: keeps alive during stream, resets on activity, expires when idle", async () => {
    const created = (
      await (
        await call("POST", "/api/links", {
          token: accessToken,
          body: {
            sourceType: "mount",
            sourcePath: "sample-archive.bin",
            expiryMode: "sliding",
            idleTtlSec: 300,
            startedIpCanResume: false,
          },
        })
      ).json()
    ).link;

    // Simulate link created 290s ago -> expires_at in 10s
    const almostExpired = Date.now() + 10_000;
    db.prepare("UPDATE links SET expires_at = ? WHERE id = ?").run(almostExpired, created.id);

    // Download resets debounce timer back to ~300s
    const dl1 = await call("GET", `/d/${created.token}`, { ip: "203.0.113.5" });
    expect(dl1.status).toBe(200);
    await dl1.arrayBuffer();

    const refreshed = db.query<{ expires_at: number }, [string]>("SELECT expires_at FROM links WHERE id = ?").get(created.id)!;
    expect(refreshed.expires_at).toBeGreaterThan(almostExpired + 250_000);

    // Simulate active transfer while expires_at has passed: sweeper must NOT expire it
    const ac = new AbortController();
    registerTransfer({
      id: "tx-active-1",
      linkId: created.id,
      token: created.token,
      filename: "sample-archive.bin",
      ip: "203.0.113.5",
      userAgent: "curl",
      rangeStart: 0,
      rangeEnd: 1000,
      totalRangeBytes: 1001,
      fileSize: sampleContent.length,
      abortController: ac,
    });
    db.prepare("UPDATE links SET expires_at = ? WHERE id = ?").run(Date.now() - 5_000, created.id);
    sweepMaintenance();
    const rowDuringStream = db.query<any, [string]>("SELECT * FROM links WHERE id = ?").get(created.id);
    expect(rowDuringStream.status).toBe("active");
    expect(computeEffectiveStatus(rowDuringStream, Date.now(), 1, []).effectiveStatus).toBe("resume_only");

    // Heartbeat / finish pushes sliding timer forward again
    refreshLinkActivity(created.id, "203.0.113.5", 1024);
    finishTransfer("tx-active-1");
    const afterFinish = db.query<{ expires_at: number }, [string]>("SELECT expires_at FROM links WHERE id = ?").get(created.id)!;
    expect(afterFinish.expires_at).toBeGreaterThan(Date.now() + 250_000);

    // Now expire it cleanly with 0 active transfers
    db.prepare("UPDATE links SET expires_at = ? WHERE id = ?").run(Date.now() - 1000, created.id);
    const expiredRes = await call("GET", `/d/${created.token}`, { ip: "203.0.113.6" });
    expect(expiredRes.status).toBe(410);
    sweepMaintenance();
    const rowAfterSweep = db.query<{ status: string }, [string]>("SELECT status FROM links WHERE id = ?").get(created.id)!;
    expect(rowAfterSweep.status).toBe("expired");
  });

  test("7. Fixed expiration + started_ip_can_resume keeps started IP resuming after link expires for others", async () => {
    const created = (
      await (
        await call("POST", "/api/links", {
          token: accessToken,
          body: {
            sourceType: "mount",
            sourcePath: "sample-archive.bin",
            expiryMode: "fixed",
            fixedTtlSec: 3600,
            startedIpCanResume: true,
            resumeGraceSec: 7200,
          },
        })
      ).json()
    ).link;

    // IP A starts downloading before expiration
    const startA = await call("GET", `/d/${created.token}`, {
      ip: "198.51.100.50",
      headers: { Range: "bytes=0-1023" },
    });
    expect(startA.status).toBe(206);
    await startA.arrayBuffer();

    // Fixed deadline passes
    db.prepare("UPDATE links SET expires_at = ? WHERE id = ?").run(Date.now() - 1000, created.id);

    // Sweeper must keep status 'active' while IP A is in resume grace
    sweepMaintenance();
    const detail = await (await call("GET", `/api/links/${created.id}`, { token: accessToken })).json();
    expect(detail.link.status).toBe("active");
    expect(detail.link.effectiveStatus).toBe("resume_only");

    // New IP B gets 410 Gone
    const tryB = await call("GET", `/d/${created.token}`, { ip: "198.51.100.99" });
    expect(tryB.status).toBe(410);

    // Started IP A CAN resume with Range
    const resumeA = await call("GET", `/d/${created.token}`, {
      ip: "198.51.100.50",
      headers: { Range: "bytes=1024-2047" },
    });
    expect(resumeA.status).toBe(206);
    expect(Buffer.from(await resumeA.arrayBuffer()).equals(sampleContent.subarray(1024, 2048))).toBe(true);

    // Once IP A's last_activity_at exceeds resumeGraceSec, IP A also gets 410 and sweeper expires link
    db.prepare("UPDATE link_authorized_ips SET last_activity_at = ? WHERE link_id = ?").run(
      Date.now() - 8000_000,
      created.id,
    );
    const expiredA = await call("GET", `/d/${created.token}`, { ip: "198.51.100.50" });
    expect(expiredA.status).toBe(410);
    sweepMaintenance();
    const afterGrace = db.query<{ status: string }, [string]>("SELECT status FROM links WHERE id = ?").get(created.id)!;
    expect(afterGrace.status).toBe("expired");
  });

  test("8. IP Whitelist, Lock-to-First-IP + Unlock, and Max Downloads (Range-safe)", async () => {
    const wlLink = (
      await (
        await call("POST", "/api/links", {
          token: accessToken,
          body: {
            sourceType: "mount",
            sourcePath: "sample-archive.bin",
            expiryMode: "never",
            ipWhitelist: ["203.0.113.0/24", "2001:db8::1"],
          },
        })
      ).json()
    ).link;

    expect((await call("GET", `/d/${wlLink.token}`, { ip: "198.51.100.1" })).status).toBe(403);
    expect((await call("GET", `/d/${wlLink.token}`, { ip: "203.0.113.42" })).status).toBe(200);
    expect((await call("GET", `/d/${wlLink.token}`, { ip: "2001:0db8::1" })).status).toBe(200);

    // Lock to first IP + maxDownloads = 1
    const lockLink = (
      await (
        await call("POST", "/api/links", {
          token: accessToken,
          body: {
            sourceType: "mount",
            sourcePath: "sample-archive.bin",
            expiryMode: "never",
            lockToFirstIp: true,
            maxDownloads: 1,
          },
        })
      ).json()
    ).link;

    const first = await call("GET", `/d/${lockLink.token}`, {
      ip: "192.0.2.10",
      headers: { Range: "bytes=0-99" },
    });
    expect(first.status).toBe(206);
    await first.arrayBuffer();

    // Same IP resuming does not double-count maxDownloads=1
    const cont = await call("GET", `/d/${lockLink.token}`, {
      ip: "192.0.2.10",
      headers: { Range: "bytes=100-199" },
    });
    expect(cont.status).toBe(206);

    // Different IP rejected by lock
    expect((await call("GET", `/d/${lockLink.token}`, { ip: "192.0.2.20" })).status).toBe(403);

    // Admin unlocks IP; maxDownloads=1 still blocks a brand-new download (even if Range > 0 is attempted!)
    expect((await call("POST", `/api/links/${lockLink.id}/unlock-ip`, { token: accessToken, body: {} })).status).toBe(200);
    expect((await call("GET", `/d/${lockLink.token}`, { ip: "192.0.2.20" })).status).toBe(410);
    expect(
      (await call("GET", `/d/${lockLink.token}`, { ip: "192.0.2.20", headers: { Range: "bytes=10-20" } })).status,
    ).toBe(410);
  });

  test("9. Password protection (HTML unlock cookie, Basic Auth, X-CDL-Password) & Revoke", async () => {
    const pwLink = (
      await (
        await call("POST", "/api/links", {
          token: accessToken,
          body: {
            sourceType: "mount",
            sourcePath: "sample-archive.bin",
            expiryMode: "never",
            password: "friend-secret-password",
          },
        })
      ).json()
    ).link;

    // CLI without password -> 401 + WWW-Authenticate
    const noPw = await call("GET", `/d/${pwLink.token}`, { ip: "198.51.100.7" });
    expect(noPw.status).toBe(401);
    expect(noPw.headers.get("www-authenticate")).toContain("Basic");

    // Browser Accept: text/html -> HTML unlock form
    const htmlPrompt = await call("GET", `/d/${pwLink.token}`, {
      ip: "198.51.100.7",
      headers: { Accept: "text/html" },
    });
    expect(htmlPrompt.status).toBe(401);
    expect(await htmlPrompt.text()).toContain(`action="/lalala/d/${pwLink.token}/unlock"`);

    // Wrong password POST
    const wrongPost = await call("POST", `/lalala/d/${pwLink.token}/unlock`, {
      ip: "198.51.100.7",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      rawBody: "password=wrong",
    });
    expect(wrongPost.status).toBe(401);

    // Correct password POST -> 303 + HttpOnly cookie -> download works with cookie
    const okPost = await call("POST", `/lalala/d/${pwLink.token}/unlock`, {
      ip: "198.51.100.7",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      rawBody: "password=friend-secret-password",
    });
    expect(okPost.status).toBe(303);
    const setCookie = okPost.headers.get("set-cookie") || "";
    const cookiePair = setCookie.split(";")[0]!;
    expect(setCookie).toContain("HttpOnly");

    const cookieDl = await call("GET", `/lalala/d/${pwLink.token}`, {
      ip: "198.51.100.7",
      headers: { Cookie: cookiePair },
    });
    expect(cookieDl.status).toBe(200);

    // X-CDL-Password header & Basic Auth
    const hdrDl = await call("GET", `/d/${pwLink.token}`, {
      ip: "198.51.100.8",
      headers: { "X-CDL-Password": "friend-secret-password" },
    });
    expect(hdrDl.status).toBe(200);

    const basic = Buffer.from("user:friend-secret-password").toString("base64");
    const basicDl = await call("GET", `/d/${pwLink.token}`, {
      ip: "198.51.100.9",
      headers: { Authorization: `Basic ${basic}` },
    });
    expect(basicDl.status).toBe(200);

    // Revoke kills link
    const revRes = await call("POST", `/api/links/${pwLink.id}/revoke`, { token: accessToken, body: {} });
    expect(revRes.status).toBe(200);
    expect((await call("GET", `/d/${pwLink.token}`, { ip: "198.51.100.8", headers: { "X-CDL-Password": "friend-secret-password" } })).status).toBe(410);
  });

  test("10. Chunked PC upload, direct download, and autoDeleteFile cleanup on expiration", async () => {
    const payload = Buffer.alloc(4096);
    for (let i = 0; i < payload.length; i++) payload[i] = (i * 17) & 0xff;

    const init = await (
      await call("POST", "/api/uploads/init", {
        token: accessToken,
        body: { filename: "pc-upload.bin", sizeBytes: payload.length },
      })
    ).json();
    const uploadId = init.upload.id;

    // Upload in 2 chunks
    const c1 = await call("PUT", `/api/uploads/${uploadId}/chunk?offset=0`, {
      token: accessToken,
      rawBody: payload.subarray(0, 2048),
    });
    expect(c1.status).toBe(200);

    const c2 = await call("PUT", `/api/uploads/${uploadId}/chunk?offset=2048`, {
      token: accessToken,
      rawBody: payload.subarray(2048),
    });
    expect(c2.status).toBe(200);

    const comp = await call("POST", `/api/uploads/${uploadId}/complete`, { token: accessToken, body: {} });
    expect(comp.status).toBe(200);
    const compJson = await comp.json();
    const storedPath = path.join(testDataDir, "uploads", compJson.upload.storedName);
    expect(existsSync(storedPath)).toBe(true);

    const upLink = (
      await (
        await call("POST", "/api/links", {
          token: accessToken,
          body: {
            sourceType: "upload",
            uploadId,
            expiryMode: "fixed",
            fixedTtlSec: 120,
            startedIpCanResume: false,
            autoDeleteFile: true,
          },
        })
      ).json()
    ).link;

    const dl = await call("GET", `/d/${upLink.token}/pc-upload.bin`, { ip: "198.51.100.60" });
    expect(dl.status).toBe(200);
    expect(Buffer.from(await dl.arrayBuffer()).equals(payload)).toBe(true);

    // Expire link -> sweep should mark expired AND delete uploaded file
    db.prepare("UPDATE links SET expires_at = ? WHERE id = ?").run(Date.now() - 1000, upLink.id);
    const sweepRes = sweepMaintenance();
    expect(sweepRes.expiredLinks).toBeGreaterThanOrEqual(1);
    expect(sweepRes.deletedUploads).toBe(1);
    expect(existsSync(storedPath)).toBe(false);
  });

  test("11. Real HTTP server preserves exact Content-Length (no Transfer-Encoding: chunked) on multi-chunk streamed downloads", async () => {
    const bigSize = 1572864; // 1.5 MiB = 3 x 512 KiB chunks
    const bigBuf = Buffer.alloc(bigSize);
    for (let i = 0; i < bigBuf.length; i++) bigBuf[i] = (i * 19 + 5) & 0xff;
    writeFileSync(path.join(testFilesDir, "multi-chunk.bin"), bigBuf);

    const link = (
      await (
        await call("POST", "/api/links", {
          token: accessToken,
          body: { sourceType: "mount", sourcePath: "multi-chunk.bin", expiryMode: "never" },
        })
      ).json()
    ).link;

    const srv = createHttpServer();
    await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
    const port = (srv.address() as { port: number }).port;
    const base = `http://127.0.0.1:${port}`;

    try {
      // Full GET over real TCP HTTP
      const res = await fetch(`${base}/lalala/d/${link.token}/multi-chunk.bin`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-length")).toBe(String(bigSize));
      expect(res.headers.get("transfer-encoding")).toBeNull();
      expect(res.headers.get("cache-control")).toContain("no-transform");
      expect(Buffer.from(await res.arrayBuffer()).equals(bigBuf)).toBe(true);

      // Range GET over real TCP HTTP
      const rangeRes = await fetch(`${base}/lalala/d/${link.token}/multi-chunk.bin`, {
        headers: { Range: "bytes=600000-1200000" },
      });
      expect(rangeRes.status).toBe(206);
      expect(rangeRes.headers.get("content-length")).toBe("600001");
      expect(rangeRes.headers.get("transfer-encoding")).toBeNull();
      expect(rangeRes.headers.get("content-range")).toBe(`bytes 600000-1200000/${bigSize}`);
      expect(Buffer.from(await rangeRes.arrayBuffer()).equals(bigBuf.subarray(600000, 1200001))).toBe(true);

      // Chunked PUT upload over real TCP HTTP
      const upBytes = Buffer.alloc(3000, 0x5a);
      const upInit = await (
        await fetch(`${base}/lalala/api/uploads/init`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
          body: JSON.stringify({ filename: "http-up.bin", sizeBytes: upBytes.length }),
        })
      ).json();
      const putRes = await fetch(`${base}/lalala/api/uploads/${upInit.upload.id}/chunk?offset=0`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/octet-stream" },
        body: upBytes,
      });
      expect(putRes.status).toBe(200);
      const compRes = await fetch(`${base}/lalala/api/uploads/${upInit.upload.id}/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
        body: "{}",
      });
      expect(compRes.status).toBe(200);
    } finally {
      await new Promise<void>((resolve) => srv.close(() => resolve()));
    }
  });
});
