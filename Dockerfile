# syntax=docker/dockerfile:1
#
# bunq-mcp: an MCP server (Streamable HTTP at /mcp, GET /health) for one bunq
# user's API key. Runs as uid 10001, never root; writes only to /data (its
# key pair and bunq context), so the root file system can be read-only.
#
#   docker run -d --name bunq-mcp -p 127.0.0.1:8080:8080 \
#     -v bunq-mcp-data:/data -e BUNQ_API_KEY -e MCP_AUTH_TOKEN \
#     --read-only --cap-drop ALL --security-opt no-new-privileges \
#     ghcr.io/kaperkunde/bunq-mcp@sha256:<digest>
#
# It dials api.bunq.com only (public-api.sandbox.bunq.com with
# BUNQ_ENVIRONMENT=sandbox); see README.md, "Where it connects".

ARG NODE_IMAGE=docker.io/library/node:24.22.2-alpine@sha256:a34ab6d7f6f4813f4d0c5469d74685604b962fbdbf5793a7bc7b4998ecb867c8
ARG PNPM_VERSION=10.33.0

# ---- build: compile TypeScript -----------------------------------------------
FROM ${NODE_IMAGE} AS build
ARG PNPM_VERSION
RUN npm install -g --no-update-notifier "pnpm@${PNPM_VERSION}"
WORKDIR /src
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm build

# ---- deps: production dependencies only, exactly as locked -------------------
FROM ${NODE_IMAGE} AS deps
ARG PNPM_VERSION
RUN npm install -g --no-update-notifier "pnpm@${PNPM_VERSION}"
WORKDIR /src
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN pnpm install --frozen-lockfile --prod --ignore-scripts

# ---- runtime -------------------------------------------------------------------
FROM ${NODE_IMAGE}
LABEL org.opencontainers.image.source="https://github.com/kaperkunde/bunq-mcp" \
      org.opencontainers.image.description="bunq over MCP for PCP: reads, and draft payments the owner accepts in the bunq app" \
      org.opencontainers.image.licenses="MIT"

# No package manager at run time: npm, npx, corepack and yarn go.
RUN rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx \
        /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-* \
    && mkdir /data && chown 10001:10001 /data && chmod 700 /data

WORKDIR /app
COPY --from=deps /src/node_modules ./node_modules
COPY --from=build /src/dist ./dist
COPY package.json LICENSE ./

ENV NODE_ENV=production \
    BUNQ_DATA_DIR=/data \
    MCP_HOST=0.0.0.0 \
    MCP_PORT=8080

USER 10001:10001
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/health || exit 1

CMD ["node", "dist/main.js"]
