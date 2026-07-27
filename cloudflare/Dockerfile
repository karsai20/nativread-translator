FROM oven/bun:1.3.14-slim@sha256:d56a2534ffd262e92c12fd3249d3924d296d97086da773f821d7d0477435ea04

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY tsconfig.json ./
COPY lib ./lib
COPY cloudflare/runner.ts ./cloudflare/runner.ts

ENV NODE_ENV=production
EXPOSE 8080

USER bun
CMD ["bun", "run", "cloudflare/runner.ts"]
