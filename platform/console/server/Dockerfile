ARG NODE_TAG=22-bookworm-slim

FROM node:${NODE_TAG} AS deps
WORKDIR /app

COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM node:${NODE_TAG}

RUN apt-get update \
 && apt-get install -y --no-install-recommends tini \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    ARGUS_HOST=0.0.0.0 \
    ARGUS_PORT=8787 \
    ARGUS_AUTH=session \
    ARGUS_AUTH_OPERATORS_FILE=/config/operators.json

WORKDIR /app

COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node server/    ./server/
COPY --chown=node:node prototype/ ./prototype/
COPY --chown=node:node tools/     ./tools/

RUN mkdir -p /state && chown node:node /state

USER node

WORKDIR /app/server
EXPOSE 8787

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "src/index.js"]
