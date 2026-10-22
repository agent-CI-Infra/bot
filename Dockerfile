FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
RUN groupadd --gid 10001 bot && useradd --uid 10001 --gid bot --no-create-home bot \
    && mkdir /data /keys /internal && chown bot:bot /data /keys /internal && chmod 700 /data /keys && chmod 750 /internal
COPY --from=build /app/dist ./dist
COPY static ./static
COPY LICENSE ./LICENSE
COPY NOTICE ./NOTICE
USER 10001:10001
EXPOSE 8791 8792
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s \
  CMD ["node", "--input-type=module", "-e", "const r = await fetch('http://127.0.0.1:8792/healthz'); if (!r.ok) process.exit(1)"]
CMD ["node", "dist/main.js"]
