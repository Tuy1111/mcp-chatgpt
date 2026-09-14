# syntax=docker/dockerfile:1

FROM node:22-alpine AS builder
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm build

FROM node:22-alpine AS runtime
# git backs git_status/git_diff/git_log; ripgrep backs code_search (without it
# the server falls back to a slower built-in scanner). docker-cli +
# docker-cli-compose back the `deploy` tool, which shells out to `git pull`
# and `docker compose build|up` against the host daemon.
RUN apk add --no-cache git ripgrep tini docker-cli docker-cli-compose
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod && pnpm store prune
COPY --from=builder /app/dist ./dist

# Workspaces are mounted here; the image itself contains no user code.
RUN mkdir -p /workspace && chown node:node /workspace
# Stays non-root. Reaching /var/run/docker.sock for the `deploy` tool therefore
# needs the host's docker group id granted at runtime; compose.yaml does that
# with `group_add`. A server that runs model-chosen commands should not be uid 0.
USER node
ENV NODE_ENV=production PORT=8787 HOST=0.0.0.0
EXPOSE 8787

# Binding 0.0.0.0 without MCP_AUTH_TOKEN makes the entrypoint exit 1 on purpose.
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--", "node", "dist/bin/http.js"]
CMD ["--workspace-root", "/workspace"]

