# ─── Build stage ─────────────────────────────────────────────────────────────
FROM node:20-alpine AS build
WORKDIR /app

# Install all deps (including dev) so the NestJS compiler and Prisma generator
# are available.
COPY package*.json ./
# npm workspaces (issue #446): the workspace manifest must exist before install.
COPY packages/solver-sdk/package.json ./packages/solver-sdk/
RUN npm install

# Copy source + Prisma schema before generating so the client is built from the
# correct schema rather than whatever was cached in node_modules.
COPY prisma ./prisma
RUN npm run db:generate

COPY . .
RUN npm run build

# ─── Canary stage (issue #496) ───────────────────────────────────────────────
# Synthetic lifecycle monitor; build with `--target canary`. Reuses the build
# stage (full deps + source) because the runner executes via tsx.
FROM build AS canary
ENTRYPOINT ["npx", "tsx", "tools/canary/canary.ts"]

# ─── Runtime stage ───────────────────────────────────────────────────────────
FROM node:20-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production

# Install production-only deps and keep the runtime image slim.
COPY package*.json ./
COPY packages/solver-sdk/package.json ./packages/solver-sdk/
RUN npm ci --omit=dev --ignore-scripts=false && npm cache clean --force

# Copy generated Prisma client and migration files so `migrate deploy` works at
# container start without needing the full dev toolchain.
COPY --from=build /app/node_modules/.prisma               ./node_modules/.prisma
COPY --from=build /app/node_modules/@prisma/client        ./node_modules/@prisma/client
COPY --from=build /app/prisma                             ./prisma
COPY --from=build /app/dist                               ./dist

# Migration entrypoint (issue #497). The pre-deploy Kubernetes Job (rendered
# from deploy/k8s/migration-job.yaml) runs `node scripts/db-migrate-locked.js`
# from *this* image, so the script has to ship in the image that migrates —
# "the image that deploys is the image that migrates".
COPY --from=build /app/scripts                            ./scripts

# Prisma CLI in the runtime image (issue #497). `prisma` is a devDependency, so
# the production install above does not include it — and an unpinned
# `npx prisma` (what the CMD below used to do) downloads the *latest* CLI at
# container start: a different major Prisma version than the one that generated
# these migrations. Installing the exact pin from package.json keeps the CLI and
# its schema engine inside the signed image, so `migrate deploy` never fetches
# code from npm at migration time. NODE_ENV=production (set above) makes npm
# treat this as an production-only install, keeping the image slim.
RUN npm install --no-save --omit=dev "prisma@$(node -p "require('./package.json').devDependencies.prisma")" \
  && npm cache clean --force

EXPOSE 4000

# Run pending migrations then start the server.
# `migrate deploy` is idempotent — it only applies un-applied migrations.
#
# The migration goes through the locked entrypoint (issue #497), not a bare
# `npx prisma migrate deploy`: a pod that starts while a CD migration Job is
# already applying DDL must queue on the same PostgreSQL advisory lock instead
# of interleaving with it. `scripts/db-migrate-locked.js` writes the
# `_migration_checkpoints` marker for this path too, and fails closed if the
# lock cannot be acquired within the bounded wait.
CMD ["sh", "-c", "node scripts/db-migrate-locked.js && node dist/main.js"]
