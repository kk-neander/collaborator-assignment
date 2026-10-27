# One image runs every Split Brain service (relay, chaos, bot, tools).
# Pinned so every laptop builds the same thing.
FROM node:24.22.1-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/protocol/package.json packages/protocol/
COPY packages/sync/package.json packages/sync/
COPY packages/contract/package.json packages/contract/
COPY packages/sim/package.json packages/sim/
COPY apps/relay/package.json apps/relay/
COPY apps/chaos/package.json apps/chaos/
COPY apps/web/package.json apps/web/
COPY apps/bot/package.json apps/bot/
COPY apps/runner/package.json apps/runner/
COPY harness/score/package.json harness/score/
RUN npm ci --no-audit --no-fund

FROM deps AS build
COPY . .
RUN npm run build -w @split-brain/web

FROM node:24.22.1-slim AS app
ENV NODE_ENV=production NODE_NO_WARNINGS=1
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=deps /app/node_modules ./node_modules
COPY . .
COPY --from=build /app/apps/web/dist ./apps/web/dist
EXPOSE 4000 8080
CMD ["node", "apps/relay/src/main.ts"]

# The runner executes the shared workspace on "Run". Separate, minimal image
# with only the workspace's own toolchain; it sits on an internal network.
FROM node:24.22.1-slim AS runner
WORKDIR /opt/tiny-notes
COPY workspace-seed/package.json ./
RUN npm install --no-audit --no-fund && npm cache clean --force
WORKDIR /srv
COPY apps/runner/src ./src
RUN useradd --create-home runner
USER runner
ENV RUNNER_DEPS=/opt/tiny-notes/node_modules NODE_NO_WARNINGS=1
EXPOSE 5000
CMD ["node", "src/main.ts"]
