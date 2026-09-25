# Portex server image: the API (apps/api) and the testnet activity runner (tools/mock).
# Build from the repository root: docker build -f deploy/Dockerfile .
FROM oven/bun:1.4.2-slim
WORKDIR /app

# Workspace manifests first, so dependency installs are cached across code changes.
COPY package.json bun.lock ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY tools/package.json tools/package.json
COPY packages/contracts/package.json packages/contracts/package.json
RUN bun install --frozen-lockfile --production --filter '@portex/api' --filter '@portex/tools'

COPY packages/contracts/abi packages/contracts/abi
COPY packages/contracts/deployments packages/contracts/deployments
COPY apps/api apps/api
COPY tools tools
RUN cd apps/api && bun --no-env-file run sync-abi

ENV NODE_ENV=production
EXPOSE 8790
WORKDIR /app/apps/api
CMD ["bun", "--no-env-file", "src/server-v2.ts"]
