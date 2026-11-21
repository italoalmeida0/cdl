import { Database } from "bun:sqlite";
import { mkdirSync } from "fs";
import path from "path";

import { DATA_DIR, LIMITS, UPLOADS_DIR } from "./config";

mkdirSync(DATA_DIR, { recursive: true });
mkdirSync(UPLOADS_DIR, { recursive: true });

export const db = new Database(path.join(DATA_DIR, "cdl.db"), { create: true });

db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");
db.exec(`PRAGMA busy_timeout = ${LIMITS.sqliteBusyTimeoutMs}`);

type Migration = { name: string; up: string };

const MIGRATIONS: Migration[] = [
  {
    name: "001_init",
    up: `
      -- Single admin account (id = 1 enforced at schema level)
      CREATE TABLE admin_account (
        id            INTEGER PRIMARY KEY CHECK (id = 1),
        username      TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        totp_secret   TEXT,
        totp_pending  TEXT,
        created_at    INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL
      );

      -- Admin sessions
      CREATE TABLE sessions (
        jti            TEXT PRIMARY KEY,
        refresh_hash   TEXT NOT NULL UNIQUE,
        created_at     INTEGER NOT NULL,
        last_used_at   INTEGER NOT NULL,
        expires_at     INTEGER NOT NULL,
        abs_expires_at INTEGER NOT NULL,
        revoked        INTEGER NOT NULL DEFAULT 0,
        ip             TEXT,
        ua             TEXT,
        family         TEXT NOT NULL
      );
      CREATE INDEX idx_sessions_family ON sessions(family);

      -- 2FA pending challenge tokens
      CREATE TABLE auth_challenges (
        id         TEXT PRIMARY KEY,
        expires_at INTEGER NOT NULL
      );

      -- Key/value settings
      CREATE TABLE settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      -- Chunked PC uploads
      CREATE TABLE uploads (
        id             TEXT PRIMARY KEY,
        original_name  TEXT NOT NULL,
        stored_name    TEXT NOT NULL UNIQUE,
        size_bytes     INTEGER NOT NULL,
        received_bytes INTEGER NOT NULL DEFAULT 0,
        mime_type      TEXT NOT NULL DEFAULT 'application/octet-stream',
        sha256         TEXT,
        status         TEXT NOT NULL CHECK (status IN ('uploading','ready','deleted')),
        created_at     INTEGER NOT NULL,
        completed_at   INTEGER
      );
      CREATE INDEX idx_uploads_status ON uploads(status);

      -- Cached SHA-256 digests keyed by file identity + size + mtime
      CREATE TABLE file_checksums (
        file_key    TEXT PRIMARY KEY,
        size_bytes  INTEGER NOT NULL,
        mtime_ms    INTEGER NOT NULL,
        sha256      TEXT NOT NULL,
        computed_at INTEGER NOT NULL
      );

      -- Shareable download links
      CREATE TABLE links (
        id                     TEXT PRIMARY KEY,
        token                  TEXT NOT NULL UNIQUE,
        label                  TEXT NOT NULL DEFAULT '',
        source_type            TEXT NOT NULL CHECK (source_type IN ('mount','upload')),
        source_path            TEXT NOT NULL,
        upload_id              TEXT REFERENCES uploads(id) ON DELETE SET NULL,
        download_filename      TEXT NOT NULL,
        file_size              INTEGER NOT NULL,
        mime_type              TEXT NOT NULL DEFAULT 'application/octet-stream',
        expiry_mode            TEXT NOT NULL CHECK (expiry_mode IN ('sliding','fixed','never')),
        idle_ttl_sec           INTEGER,
        expires_at             INTEGER,
        hard_expires_at        INTEGER,
        started_ip_can_resume  INTEGER NOT NULL DEFAULT 1,
        resume_grace_sec       INTEGER NOT NULL DEFAULT 10800,
        lock_to_first_ip       INTEGER NOT NULL DEFAULT 0,
        locked_ip              TEXT,
        ip_whitelist           TEXT NOT NULL DEFAULT '[]',
        max_downloads          INTEGER,
        download_count         INTEGER NOT NULL DEFAULT 0,
        total_bytes_served     INTEGER NOT NULL DEFAULT 0,
        password_hash          TEXT,
        allow_inline           INTEGER NOT NULL DEFAULT 0,
        auto_delete_file       INTEGER NOT NULL DEFAULT 0,
        max_speed_kbps         INTEGER,
        notes                  TEXT NOT NULL DEFAULT '',
        status                 TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','revoked','expired')),
        created_at             INTEGER NOT NULL,
        last_activity_at       INTEGER
      );
      CREATE INDEX idx_links_token ON links(token);
      CREATE INDEX idx_links_status ON links(status);
      CREATE INDEX idx_links_upload ON links(upload_id);
      CREATE INDEX idx_links_source ON links(source_type, source_path);

      -- Per-IP tracking for started downloads and resume eligibility
      CREATE TABLE link_authorized_ips (
        link_id          TEXT NOT NULL REFERENCES links(id) ON DELETE CASCADE,
        ip               TEXT NOT NULL,
        first_started_at INTEGER NOT NULL,
        last_activity_at INTEGER NOT NULL,
        requests_count   INTEGER NOT NULL DEFAULT 1,
        bytes_sent       INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (link_id, ip)
      );
      CREATE INDEX idx_link_auth_ips_link ON link_authorized_ips(link_id);

      -- Download & access event history
      CREATE TABLE download_events (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        link_id     TEXT NOT NULL REFERENCES links(id) ON DELETE CASCADE,
        ts          INTEGER NOT NULL,
        ip          TEXT NOT NULL,
        user_agent  TEXT NOT NULL DEFAULT '',
        method      TEXT NOT NULL,
        range_start INTEGER,
        range_end   INTEGER,
        bytes_sent  INTEGER NOT NULL DEFAULT 0,
        status      INTEGER NOT NULL,
        outcome     TEXT NOT NULL,
        duration_ms INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX idx_dl_events_link_ts ON download_events(link_id, ts);
      CREATE INDEX idx_dl_events_ts ON download_events(ts);

      -- Admin audit trail
      CREATE TABLE audit_log (
        id     INTEGER PRIMARY KEY AUTOINCREMENT,
        ts     INTEGER NOT NULL,
        action TEXT NOT NULL,
        target TEXT,
        meta   TEXT,
        ip     TEXT
      );
      CREATE INDEX idx_audit_ts ON audit_log(ts);
    `,
  },
];

function runMigrations(): void {
  const current = db.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version;
  for (let i = current; i < MIGRATIONS.length; i++) {
    const m = MIGRATIONS[i]!;
    db.transaction(() => {
      db.exec(m.up);
      db.exec(`PRAGMA user_version = ${i + 1}`);
    })();
    console.log(`[DB] applied migration ${m.name}`);
  }
}

runMigrations();

export interface AdminAccountRow {
  id: number;
  username: string;
  password_hash: string;
  totp_secret: string | null;
  totp_pending: string | null;
  created_at: number;
  updated_at: number;
}

export interface SessionRow {
  jti: string;
  refresh_hash: string;
  created_at: number;
  last_used_at: number;
  expires_at: number;
  abs_expires_at: number;
  revoked: number;
  ip: string | null;
  ua: string | null;
  family: string;
}

export interface UploadRow {
  id: string;
  original_name: string;
  stored_name: string;
  size_bytes: number;
  received_bytes: number;
  mime_type: string;
  sha256: string | null;
  status: "uploading" | "ready" | "deleted";
  created_at: number;
  completed_at: number | null;
}

export interface LinkRow {
  id: string;
  token: string;
  label: string;
  source_type: "mount" | "upload";
  source_path: string;
  upload_id: string | null;
  download_filename: string;
  file_size: number;
  mime_type: string;
  expiry_mode: "sliding" | "fixed" | "never";
  idle_ttl_sec: number | null;
  expires_at: number | null;
  hard_expires_at: number | null;
  started_ip_can_resume: number;
  resume_grace_sec: number;
  lock_to_first_ip: number;
  locked_ip: string | null;
  ip_whitelist: string;
  max_downloads: number | null;
  download_count: number;
  total_bytes_served: number;
  password_hash: string | null;
  allow_inline: number;
  auto_delete_file: number;
  max_speed_kbps: number | null;
  notes: string;
  status: "active" | "paused" | "revoked" | "expired";
  created_at: number;
  last_activity_at: number | null;
}

export interface LinkAuthorizedIpRow {
  link_id: string;
  ip: string;
  first_started_at: number;
  last_activity_at: number;
  requests_count: number;
  bytes_sent: number;
}

export interface DownloadEventRow {
  id: number;
  link_id: string;
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
}

export interface AuditLogRow {
  id: number;
  ts: number;
  action: string;
  target: string | null;
  meta: string | null;
  ip: string | null;
}

const immediateTx = db.transaction((fn: () => unknown) => fn());

export function inImmediateTx<T>(fn: () => T): T {
  return immediateTx.immediate(fn) as T;
}

const insertAuditStmt = db.prepare(
  "INSERT INTO audit_log (ts, action, target, meta, ip) VALUES (?, ?, ?, ?, ?)",
);

export function audit(
  action: string,
  opts: { target?: string | null; meta?: unknown; ip?: string | null } = {},
): void {
  insertAuditStmt.run(
    Date.now(),
    action,
    opts.target ?? null,
    opts.meta !== undefined ? JSON.stringify(opts.meta) : null,
    opts.ip ?? null,
  );
}

export function getSetting(key: string): string | null {
  const row = db.query<{ value: string }, [string]>("SELECT value FROM settings WHERE key = ?").get(key);
  return row ? row.value : null;
}

export function setSetting(key: string, value: string | null): void {
  if (value === null) {
    db.prepare("DELETE FROM settings WHERE key = ?").run(key);
  } else {
    db.prepare(
      "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run(key, value);
  }
}

export function runPassiveWalCheckpoint(): void {
  try {
    db.exec("PRAGMA wal_checkpoint(PASSIVE)");
  } catch (err) {
    console.warn("[DB] passive WAL checkpoint failed:", err);
  }
}
