# agent-engine image. Same image for both deployments (agent-engine and
# agent-engine-web); ENGINE_AGENTS in the values picks the agents each serves.
#
# glibc (slim, not alpine): npm installs the SDK's linux-x64 / linux-arm64 CLI
# binary from the lockfile's optional dependencies, matching this base.

FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-slim
# git: the codebase agent snapshots repos with git. tini: PID 1 that forwards
# SIGTERM to node (graceful shutdown settles running runs) and reaps the
# Claude CLI subprocesses.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git tini ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY agents ./agents
COPY config/sources.yaml config/noise.yaml config/repos.example.yaml ./config/
# Recorded on every run (get_run shows it): the CI passes the image tag.
ARG ENGINE_BUILD=unknown
ENV ENGINE_BUILD=$ENGINE_BUILD
# Numeric, so the kubelet can verify runAsNonRoot (uid 1000 = node).
USER 1000
EXPOSE 8787 9464
# Exec form: tini is PID 1 and node gets SIGTERM directly. The argo-cd values
# override this with container.command (full argv), keeping tini first.
ENTRYPOINT ["tini", "--", "node", "dist/cli.js"]
CMD ["serve", "--host", "0.0.0.0", "--port", "8787", "--metrics-port", "9464"]
