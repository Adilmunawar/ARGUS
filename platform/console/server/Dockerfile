# The Argus console API.
#
# Build context is platform/console (NOT server/), because this one image is
# three things:
#
#   /app/server      the API           -> node src/index.js
#   /app/prototype   the UI it serves  -> ARGUS_WEB_ROOT=../../prototype
#   /app/tools       one-shot jobs     -> node /app/tools/init-object-storage.js
#
# node_modules is installed at /app, one level ABOVE all three, so Node's
# directory walk finds it from /app/server/src AND from /app/tools. Installing
# it into /app/server instead builds an image where the API works and every
# init container dies on "Cannot find module @aws-sdk/client-s3" -- at 3am, in
# a depends_on chain, with the failure attributed to the service that was
# waiting on it.

ARG NODE_TAG=22-bookworm-slim

# ── dependencies ─────────────────────────────────────────────────────────────
# A separate stage so the npm cache, the build toolchain and any transitively
# compiled artefact stay out of the shipped image.
FROM node:${NODE_TAG} AS deps
WORKDIR /app

# Only the manifests, so this layer is rebuilt when dependencies change and not
# when a line of application code does. `npm ci` requires both files and fails
# loudly if they disagree -- which is the point: `npm install` would silently
# resolve a different tree than the one that was tested.
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# ── runtime ──────────────────────────────────────────────────────────────────
FROM node:${NODE_TAG}

# tini as PID 1. Node does not reap orphaned children and does not forward
# signals to them, so without an init the graceful-shutdown handler in
# src/index.js runs while any child it spawned keeps the container alive until
# Docker SIGKILLs it 10 seconds later -- which looks like a slow container, not
# a missing init.
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    ARGUS_HOST=0.0.0.0 \
    ARGUS_PORT=8787

WORKDIR /app

COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node server/    ./server/
COPY --chown=node:node prototype/ ./prototype/
COPY --chown=node:node tools/     ./tools/

# uid 1000, shipped by the node image. Declared explicitly because a future base
# change that drops the user would otherwise silently run this as root, and
# nothing in the application would notice or complain.
USER node

WORKDIR /app/server
EXPOSE 8787

# No HEALTHCHECK here: the compose file owns it, and two definitions means the
# image quietly wins on `docker run` and loses under compose, so the probe an
# operator reads is not always the probe that runs.

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "src/index.js"]
