# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# ShopSage backend image.
#
# Two runnable targets:
#   development - dev dependencies present, source bind-mounted, file watching
#   production  - runtime dependencies only, immutable source, non-root
#
# Dependency manifests are copied before the source so that editing a source
# file does not invalidate the npm install layer.
# ---------------------------------------------------------------------------
ARG NODE_VERSION=22-alpine

FROM node:${NODE_VERSION} AS base
WORKDIR /app
ENV NODE_ENV=production \
    npm_config_update_notifier=false \
    npm_config_fund=false

# Manifests only. Kept in one stage so both installs share the same layer key.
#
# **Every** workspace manifest, by wildcard rather than a hand-maintained list. The list version of
# this stage was three entries long and silently wrong for months: npm can only resolve a workspace
# whose package.json it can read, so a package added later was simply absent from node_modules, and
# the image failed at *import* time with a missing-module error that looked like a code bug. A
# wildcard cannot fall behind.
#
# `--parents` keeps the directory structure, which is the whole point - without it every manifest
# would land on the same destination path.
FROM base AS manifests
COPY package.json package-lock.json ./
COPY --parents packages/*/package.json ./

# --- Runtime dependencies -------------------------------------------------
FROM manifests AS dependencies
# --ignore-scripts: no package in this tree needs a lifecycle script, and
# refusing to run them removes an arbitrary-code-execution path from the build.
RUN npm ci --omit=dev --ignore-scripts

# --- Development ----------------------------------------------------------
FROM manifests AS development
ENV NODE_ENV=development
RUN npm ci --ignore-scripts
COPY --chown=node:node . .
USER node
EXPOSE 3000
CMD ["node", "--watch", "packages/rag-backend/src/server.js"]

# --- Production -----------------------------------------------------------
FROM base AS production
COPY --from=dependencies --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json ./
COPY --chown=node:node config ./config
COPY --chown=node:node packages ./packages

# Never run as root. The node image ships an unprivileged `node` user.
USER node
EXPOSE 3000

# Uses Node itself rather than curl or wget: neither is installed, and adding
# one would grow the image and its vulnerability surface for no benefit.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "packages/rag-backend/src/server.js"]
