# syntax=docker/dockerfile:1

# ─── Stage 1: build ──────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

# Prisma needs OpenSSL on Alpine.
RUN apk add --no-cache openssl openssl-dev

WORKDIR /app

# Install dependencies from the lockfile for a reproducible build.
# npm ci (not npm install) so the image matches package-lock.json exactly.
# npm is pinned to the version the lockfile was generated with (11.6.2):
# the stock npm 10 in node:20-alpine resolves optional peer deps differently
# and fails with "Missing: @emnapi/... from lock file".
COPY package.json package-lock.json ./
RUN npm i -g npm@11.6.2 && npm ci

COPY prisma ./prisma/
RUN npx prisma generate

COPY tsconfig*.json ./
COPY src ./src
COPY public ./public/
RUN npm run build

# Drop dev dependencies from the tree we are going to copy forward.
RUN npm prune --omit=dev

# ─── Stage 2: runtime ───────────────────────────────────────────────────────
FROM node:20-alpine AS runtime

RUN apk add --no-cache openssl openssl-dev curl

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm i -g npm@11.6.2 && npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma
# Static legal pages (privacy-policy.html, terms.html) are served from disk by
# web.routes.ts. Without this line production 404s on both — which is exactly
# what happened on the first Railway deploy: the builder stage HAD public/
# (it is not dockerignored) but the runtime stage never received it.
COPY --from=builder /app/public ./public

# ─── PostgreSQL only ─────────────────────────────────────────────────────────
# The previous image hardcoded ENV DATABASE_URL=file:/app/data/edutech.db, which
# src/utils/env.ts rejects at boot in production (it now requires a
# postgresql:// URL). The image therefore could not start. No database URL is
# baked in at all: Railway/Render inject DATABASE_URL at runtime, and
# entrypoint runs migrations against that managed instance.
#
# No VOLUME either — the database is remote and managed, so a local volume would
# only imply a persistent disk that nothing writes to.
RUN addgroup -S nodejs && adduser -S nodejs -G nodejs -u 1001 \
    && chown -R nodejs:nodejs /app

COPY docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x ./docker-entrypoint.sh

USER nodejs

EXPOSE 5000

# Migrations run here, not at build time, so they always target the live
# database rather than a throwaway image layer.
ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", "dist/src/server.js"]
