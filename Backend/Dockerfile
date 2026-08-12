# syntax=docker/dockerfile:1

# Employee Monitor backend.
#
# Multi-stage so the runtime image carries no TypeScript, no dev dependencies and no source -
# only compiled JS, production node_modules, and the generated Prisma client.

# ---------------------------------------------------------------------------
# Stage 1 - build
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS build

WORKDIR /app

# Copy manifests first so `npm ci` is cached independently of source changes.
COPY package*.json ./
RUN npm ci

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
RUN npm prune --omit=dev && npx prisma generate

# ---------------------------------------------------------------------------
# Stage 2 - runtime
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production

# Signal handling: Node as PID 1 does not reap zombies or forward signals to children, so
# `docker stop` would wait the full timeout instead of shutting down promptly.
RUN apt-get update \
    && apt-get install -y --no-install-recommends tini \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/package.json ./package.json

# Screenshot storage is a bind/volume mount at runtime. Created and owned here so the container
# can write to it even when the host directory starts empty.
RUN mkdir -p /app/storage/screenshots && chown -R node:node /app/storage

# Drop root. The app binds 5000, not a privileged port, so nothing here needs it.
USER node

EXPOSE 5000

# No HEALTHCHECK directive: compose and most orchestrators define their own probe, and baking
# one in means two competing definitions. /health is the endpoint to point them at.

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/server.js"]
