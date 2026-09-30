# syntax=docker/dockerfile:1

# CENTRIX dashboard (Next.js).
#
# Three stages: install dependencies, build with `output: "standalone"`, then run only the traced
# standalone server. The runtime image carries no source, no dev dependencies and no npm cache.

ARG NODE_VERSION=22

# ---------------------------------------------------------------------------
# Stage 1 - dependencies
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS deps

WORKDIR /app

COPY package*.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund

# ---------------------------------------------------------------------------
# Stage 2 - build
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS build

WORKDIR /app

# NEXT_PUBLIC_* values are inlined into the browser bundle at build time, so they must be known
# here and cannot be changed by setting an environment variable on the running container.
# This one is the API address the *browser* uses for Socket.IO - the public API hostname.
ARG NEXT_PUBLIC_MONITORING_API_URL
# IANA zone every clock time and date is displayed in. Must equal the API's APP_TIME_ZONE.
ARG NEXT_PUBLIC_APP_TIME_ZONE=UTC
RUN test -n "$NEXT_PUBLIC_MONITORING_API_URL" \
    || (echo "Build arg NEXT_PUBLIC_MONITORING_API_URL is required" >&2 && exit 1)

ENV NEXT_PUBLIC_MONITORING_API_URL=${NEXT_PUBLIC_MONITORING_API_URL} \
    NEXT_PUBLIC_APP_TIME_ZONE=${NEXT_PUBLIC_APP_TIME_ZONE} \
    NEXT_TELEMETRY_DISABLED=1 \
    NODE_ENV=production

COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# ---------------------------------------------------------------------------
# Stage 3 - runtime
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS runtime

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0

# tini forwards SIGTERM to the Next server and reaps zombies, so `docker stop` is prompt.
RUN apt-get update \
    && apt-get install -y --no-install-recommends tini \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# The standalone server does not serve public/ or .next/static by itself - both must sit next to
# server.js for it to find them.
COPY --from=build --chown=node:node /app/public ./public
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static

USER node

EXPOSE 3000

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server.js"]
