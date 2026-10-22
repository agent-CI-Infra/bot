FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
RUN groupadd --gid 10001 project && useradd --uid 10001 --gid project --no-create-home project \
    && mkdir /workspace && chown project:project /workspace && chmod 700 /workspace
COPY runner /opt/runner
RUN for file in /opt/runner/*.mjs; do node --check "$file"; done
COPY LICENSE NOTICE /opt/licenses/
RUN chmod -R a-w /opt/runner
USER 10001:10001
WORKDIR /workspace
CMD ["node", "/opt/runner/idle.mjs"]
