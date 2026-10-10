# syntax=docker/dockerfile:1

# Multi-stage build producing a minimal Next.js standalone runtime image.

FROM node:22-alpine AS base

# ---- deps: install all dependencies (needs full devDeps to build) ----
FROM base AS deps
RUN apk add --no-cache libc6-compat
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# ---- builder: compile the Next.js app ----
FROM base AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# The database module validates this at import time; no production secrets or
# database connection are needed to compile the dynamically rendered app.
RUN MONGODB_URI=mongodb://127.0.0.1:27017/tenant_app npm run build

# ---- seeder: one-off image to seed the initial SuperAdmin ----
# Run with: docker compose --profile seed run --rm seed
FROM base AS seeder
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY scripts ./scripts
CMD ["node", "scripts/seed.mjs"]

# ---- runner: lean production image ----
FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

RUN addgroup --system --gid 1001 nodejs \
  && adduser --system --uid 1001 nextjs

# Standalone output bundles only the files required at runtime.
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs
EXPOSE 3000

CMD ["node", "server.js"]
