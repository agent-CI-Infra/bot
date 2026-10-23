FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Production dependencies only; the runtime image has no compiler or dev tooling.
FROM node:22-bookworm-slim AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
RUN groupadd --gid 10001 bot && useradd --uid 10001 --gid bot --no-create-home bot \
    && mkdir /data /keys /internal /tunnel && chown bot:bot /data /keys /internal /tunnel && chmod 700 /data /keys /tunnel && chmod 750 /internal
COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json ./package.json
COPY --from=build /app/dist ./dist
COPY static ./static
COPY docs/external-token-api.md ./docs/external-token-api.md
# The built-in rule files; dist/rules/service.js reads them at startup.
COPY docs/prompts ./docs/prompts
COPY config ./config
COPY scripts/external-token.mjs ./scripts/external-token.mjs
# The webhook gateway service runs from this image too (node webhook/main.mjs), as its own container.
COPY webhook/main.mjs ./webhook/main.mjs
COPY LICENSE ./LICENSE
COPY NOTICE ./NOTICE
USER 10001:10001
EXPOSE 8791 8792
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s \
  CMD ["node", "--input-type=module", "-e", "const r = await fetch('http://127.0.0.1:8792/healthz'); if (!r.ok) process.exit(1)"]
CMD ["node", "dist/main.js"]
