# syntax=docker/dockerfile:1
# Multi-stage build for the Compliance DVN worker. Build context is this `worker/` dir.

# ── deps: install production dependencies against the frozen lockfile ────────
FROM node:20-bookworm-slim AS deps
WORKDIR /app
# Pin pnpm via npm rather than corepack: this base image's corepack cannot
# verify newer pnpm signatures (ERR "Cannot find matching keyid"), and the
# latest pnpm requires node:sqlite which Node 20 lacks. Keep in sync with the
# `packageManager` field in package.json.
RUN npm install -g pnpm@9.15.9
COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --prod --frozen-lockfile

# ── runtime: minimal image, non-root, runs TypeScript via tsx ────────────────
FROM node:20-bookworm-slim AS runtime
ENV NODE_ENV=production \
    HTTP_PORT=9090 \
    CHECKPOINT_PATH=/data/dvn-checkpoint.json
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Persisted checkpoint lives on a mounted volume; owned by the non-root runtime user.
RUN mkdir -p /data && chown -R node:node /app /data
USER node
VOLUME ["/data"]
EXPOSE 9090

# Liveness uses the same endpoint Kubernetes probes (Node 20 has global fetch).
HEALTHCHECK --interval=30s --timeout=3s --start-period=45s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.HTTP_PORT||9090)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node_modules/.bin/tsx", "service.ts"]
