FROM node:22-bookworm-slim
RUN groupadd --gid 10001 project && useradd --uid 10001 --gid project --no-create-home project \
    && mkdir /workspace && chown project:project /workspace && chmod 700 /workspace
COPY runner /opt/runner
COPY LICENSE NOTICE /opt/licenses/
RUN chmod -R a-w /opt/runner
USER 10001:10001
WORKDIR /workspace
CMD ["node", "/opt/runner/idle.mjs"]
