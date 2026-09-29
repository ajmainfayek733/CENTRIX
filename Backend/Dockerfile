# syntax=docker/dockerfile:1

# CENTRIX backend.
#
# Multi-stage so the runtime image carries no TypeScript, no dev dependencies and no source -
# only compiled JS, production node_modules, the generated Prisma client, and what the Prisma
# CLI needs to run `migrate deploy` from the same image.

ARG NODE_VERSION=22

# ---------------------------------------------------------------------------
# Stage 1 - build
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS build

WORKDIR /app

# Prisma's schema engine links against OpenSSL and probes for it at generate time; the slim
# image does not ship it, and without it Prisma guesses the wrong engine variant.
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Copy manifests first so `npm ci` is cached independently of source changes. The cache mount
# keeps the npm download cache across builds without baking it into a layer.
COPY package*.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund

# The schema has to be present before `prisma generate`, and generate has to run before `tsc`
# because the compiler needs the generated client's types.
COPY prisma ./prisma
COPY prisma.config.ts ./
RUN npx prisma generate

COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build

# Re-resolve dependencies without dev packages, then regenerate the client into that tree -
# the runtime stage copies this directory verbatim.
RUN npm prune --omit=dev --no-audit --no-fund && npx prisma generate

# ---------------------------------------------------------------------------
# Stage 2 - runtime
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS runtime

ENV NODE_ENV=production \
    PORT=5000

# tini: Node as PID 1 does not reap zombies or forward signals to children, so `docker stop`
# would wait the full timeout instead of triggering the graceful shutdown in server.ts.
# openssl/ca-certificates: the Prisma schema engine (migrate deploy) and TLS to RDS / S3.
RUN apt-get update \
    && apt-get install -y --no-install-recommends tini openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/prisma ./prisma
COPY --from=build --chown=node:node /app/package.json ./package.json
# Prisma 7 reads the datasource URL from prisma.config.ts, not schema.prisma. Without this file
# `prisma migrate deploy` inside the container fails with "datasource url is required".
COPY --from=build --chown=node:node /app/prisma.config.ts ./prisma.config.ts

# Local screenshot storage target (SCREENSHOT_STORAGE_PROVIDER=local). Unused with S3, where
# uploads are staged in the OS temp directory instead - but created either way so the image
# works under both providers without a rebuild.
RUN mkdir -p /app/storage/screenshots && chown -R node:node /app/storage

# Drop root. The app binds 5000, not a privileged port, so nothing here needs it.
USER node

EXPOSE 5000

# No HEALTHCHECK directive: compose and most orchestrators define their own probe, and baking
# one in means two competing definitions. /health is the endpoint to point them at.

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/server.js"]
