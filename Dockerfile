# Multi-stage: build with Bun (fast, reproducible via bun.lock), run the Next.js
# standalone output on Node. Runs as its own container on a Proxmox Docker host.

FROM oven/bun:1.3 AS builder
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bunx next build

FROM node:22-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
ENV PORT=48217
ENV JOBS_DIR=/data/jobs
ENV LIBRARY_DIR=/data/library
ENV ENTITLEMENTS_DIR=/data/entitlements

# Standalone bundle + static assets (Next does not copy static into standalone).
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static

RUN mkdir -p /data/jobs /data/library /data/entitlements
VOLUME ["/data/jobs", "/data/library", "/data/entitlements"]

EXPOSE 48217
CMD ["node", "server.js"]
