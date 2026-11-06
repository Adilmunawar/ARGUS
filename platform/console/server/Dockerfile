ARG NODE_IMAGE=node:22.23.4-bookworm-slim@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da

FROM ${NODE_IMAGE} AS deps
WORKDIR /app

COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM ${NODE_IMAGE}

ARG ARGUS_VERSION=0.1.0
ARG ARGUS_SOURCE=https://example.com/example-org/argus

LABEL org.opencontainers.image.title="Argus console" \
      org.opencontainers.image.description="The Argus operations console and its storage bootstrap tools" \
      org.opencontainers.image.source="${ARGUS_SOURCE}" \
      org.opencontainers.image.licenses="LicenseRef-Proprietary" \
      org.opencontainers.image.version="${ARGUS_VERSION}"

ENV NODE_ENV=production \
    ARGUS_HOST=0.0.0.0 \
    ARGUS_PORT=8787 \
    ARGUS_AUTH=session \
    ARGUS_AUTH_OPERATORS_FILE=/config/operators.json

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY server/    ./server/
COPY prototype/ ./prototype/
COPY tools/     ./tools/

RUN chmod -R u=rwX,go=rX /app/server /app/prototype /app/tools \
 && mkdir -p /state /audit && chown node:node /state /audit

USER node

WORKDIR /app/server
EXPOSE 8787

CMD ["node", "src/index.js"]
