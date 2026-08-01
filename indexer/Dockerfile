# syntax=docker/dockerfile:1
FROM node:20-alpine AS base
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate

FROM base AS deps
COPY package.json ./
# No lockfile is committed for this package yet, so resolve fresh. Add pnpm-lock.yaml and switch
# to --frozen-lockfile once the dependency set settles.
RUN pnpm install --prod=false

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY db ./db
COPY src ./src

# Unprivileged: the container needs nothing but outbound RPC and the database.
USER node
EXPOSE 9091

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.HTTP_PORT||9091)+'/healthz',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node_modules/.bin/tsx", "src/service.ts"]
