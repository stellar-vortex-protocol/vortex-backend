# ─── Build stage ─────────────────────────────────────────────────────────────
FROM node:20-alpine AS build
WORKDIR /app

# Install all deps (including dev) so the NestJS compiler and Prisma generator
# are available.
COPY package*.json ./
RUN npm install

# Copy source + Prisma schema before generating so the client is built from the
# correct schema rather than whatever was cached in node_modules.
COPY prisma ./prisma
RUN npm run db:generate

COPY . .
RUN npm run build

# ─── Runtime stage ───────────────────────────────────────────────────────────
FROM node:20-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production

# Install production-only deps.
COPY package*.json ./
RUN npm install --omit=dev

# Copy generated Prisma client and migration files so `migrate deploy` works at
# container start without needing the full dev toolchain.
COPY --from=build /app/node_modules/.prisma               ./node_modules/.prisma
COPY --from=build /app/node_modules/@prisma/client        ./node_modules/@prisma/client
COPY --from=build /app/prisma                             ./prisma
COPY --from=build /app/dist                               ./dist

EXPOSE 4000

# Run pending migrations then start the server.
# `migrate deploy` is idempotent — it only applies un-applied migrations.
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/main.js"]
