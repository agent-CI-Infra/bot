FROM node:22-bookworm-slim
COPY webhook/main.mjs /app/main.mjs
USER 10001:10001
CMD ["node", "/app/main.mjs"]
