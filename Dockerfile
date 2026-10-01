# One image runs the engine and the dashboard. The dashboard listens on $PORT and forwards
# /api to the engine on 127.0.0.1, so a host only has to expose a single port.
FROM oven/bun:1.3.13 AS bun

FROM node:22-slim AS base
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /app

FROM base AS build
COPY package.json bun.lock ./
COPY server/package.json server/
COPY web/package.json web/
RUN bun install --frozen-lockfile
COPY . .
ENV NEXT_PUBLIC_API_URL=/api \
    ENGINE_URL=http://127.0.0.1:4000 \
    NEXT_TELEMETRY_DISABLED=1
RUN bun run --filter '@relay/web' build

FROM base
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    ENGINE_PORT=4000 \
    DATABASE_PATH=/app/data/relay.db
COPY --from=build /app /app
EXPOSE 3000
CMD ["/app/scripts/start.sh"]
