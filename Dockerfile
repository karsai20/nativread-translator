# quire-translator — runs as its own container on a Proxmox Docker host.
FROM oven/bun:1.3

WORKDIR /app

# Install deps first for layer caching.
COPY package.json bun.lock* ./
RUN bun install --production --frozen-lockfile || bun install --production

# App source.
COPY tsconfig.json ./
COPY src ./src

# Build the browser bundle at image build time.
RUN bun run build:web

# Persist per-job resume state on a volume.
ENV JOBS_DIR=/data/jobs
VOLUME ["/data/jobs"]

# Bind all interfaces inside the container; an uncommon port by default.
ENV HOST=0.0.0.0
ENV PORT=48217
EXPOSE 48217

CMD ["bun", "run", "start"]
