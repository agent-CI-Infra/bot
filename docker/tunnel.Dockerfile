FROM cloudflare/cloudflared:2026.10.3 AS connector
FROM node:22-bookworm-slim
COPY --from=connector /usr/local/bin/cloudflared /usr/local/bin/cloudflared
COPY tunnel/main.mjs /app/main.mjs
USER 10001:10001
CMD ["node", "/app/main.mjs"]
