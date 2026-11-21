# CDL — Content Delivery Link

Self-hosted, single-admin temporary **direct download link** server built with **Bun + SQLite + SolidJS** in a lightweight Docker container.

## Features

- **Pure Direct Downloads (`/d/:token/:filename`)**: Serves `Content-Disposition: attachment` with RFC 9110 `Range` (`206 Partial Content`, `If-Range`, `416`), `HEAD`, `ETag`, `X-Checksum-SHA256`, and zero-timeout streaming for **1 TB+** files.
- **Sliding Debounce Expiration (Default 3h)**: After creation, the link stays open for the configured idle window (e.g. `3h`). Active streams never drop mid-transfer, and every download start, resume, heartbeat, and stream finish resets the idle countdown back to `0`. If idle for the full window with no active downloads, the link expires automatically.
- **Fixed & Never Modes**: Presets (`1h`, `3h`, `24h`, `48h`, `7d`, `30d`), exact custom date/time, or permanent until revoked.
- **Started-IP Resume Protection**: When a link expires while a download was started or interrupted, already-started IPs can continue resuming within a configurable grace window (`3h` default or unlimited) while new IPs receive `410 Gone`.
- **IP Security Controls**: Optional IPv4/IPv6/CIDR whitelist, atomic **Lock to first downloader IP** (with one-click admin unlock), optional link passwords (`X-CDL-Password`, Basic Auth, or browser unlock form), `max_downloads` (smartly ignoring `HEAD` and `Range` resumes), and per-link speed throttling.
- **Two File Sources**:
  1. **Mounted Folder (`FILES_DIR=/files`)**: Read-only browsable library (`-v /my/media:/files:ro`), hardened against path traversal and symlink escapes.
  2. **PC Chunked Upload (`DATA_DIR/uploads`)**: Resumable multi-GB chunked upload directly from the dashboard, with optional auto-delete when the link expires.
- **Single-Admin Auth**: No multi-tenant bloat or Google sign-in. Bootstrap via `ADMIN_PASSWORD` or complete one-time setup in the browser, with optional TOTP 2FA.
- **Runtime Subpath (`BASE_URL`) Support**: Pass `BASE_URL=https://example.com/lalala/` at container startup—works with or without prefix stripping by your reverse proxy.

## Quick Start (Docker)

```bash
docker build -t cdl .

docker run -d --name cdl \
  -p 3000:3000 \
  -v cdl-data:/data \
  -v /path/to/your/files:/files:ro \
  -e BASE_URL="https://example.com/lalala/" \
  -e ADMIN_USERNAME="admin" \
  -e ADMIN_PASSWORD="your-strong-password" \
  -e TRUST_PROXY="true" \
  cdl
```

Open `https://example.com/lalala/` (or `http://localhost:3000/lalala/` locally).

## Reverse Proxy (Nginx Subpath Example)

```nginx
location /lalala/ {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_buffering off;
    proxy_request_buffering off;
    client_max_body_size 0;
}
```

## Development

```bash
bun install
bun run typecheck
bun run build
bun test
bun run dev
```
