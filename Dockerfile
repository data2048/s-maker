# syntax=docker/dockerfile:1

# ---- build: install everything, build web + server ----
FROM node:24-slim AS build
WORKDIR /src
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

# ---- deps: production dependencies of the server only ----
FROM node:24-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN npm ci --omit=dev --workspace apps/server --include-workspace-root=false --no-audit --no-fund \
  && rm -rf node_modules/@s-maker

# ---- runtime ----
FROM node:24-slim
ARG APP_VERSION=dev
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=44566 \
    DATA_DIR=/data \
    WEB_DIST=/app/apps/web/dist \
    APP_VERSION=${APP_VERSION}
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY apps/server/package.json ./apps/server/package.json
COPY --from=build /src/apps/server/dist ./apps/server/dist
COPY --from=build /src/apps/web/dist ./apps/web/dist
COPY kb/strudel-cheatsheet.md kb/music-elements.md ./kb/
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 44566
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:44566/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "--disable-warning=ExperimentalWarning", "--enable-source-maps", "apps/server/dist/index.js"]
