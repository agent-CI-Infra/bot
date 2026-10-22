FROM node:22-bookworm-slim
WORKDIR /app
COPY manager ./manager
COPY LICENSE ./LICENSE
COPY NOTICE ./NOTICE
RUN mkdir /data && chmod 700 /data
USER 0:10001
CMD ["node", "manager/main.mjs"]
