# ===== Build stage: bundle the CDL dashboard SPA =====
FROM oven/bun:1-slim AS webbuild
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY plugins ./plugins
COPY build.ts tsconfig.json ./
COPY web ./web
RUN bun ./build.ts

# ===== Runtime stage: Bun server + built SPA =====
FROM oven/bun:1-slim
WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    DATA_DIR=/data \
    FILES_DIR=/files \
    STATIC_DIR=/app/dist

COPY package.json ./
COPY server ./server
COPY --from=webbuild /app/dist ./dist

# Non-root bun user owns /app, /data, and /files mountpoint
RUN mkdir -p /data /data/uploads /files \
    && chown -R bun:bun /app /data /files
USER bun

VOLUME ["/data", "/files"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["bun", "server/index.ts"]
