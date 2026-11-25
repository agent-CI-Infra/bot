FROM node:22-bookworm-slim
WORKDIR /app
COPY manager ./manager
COPY runner/notes.mjs runner/note-path.mjs runner/note-catalog.mjs runner/image-budget.mjs runner/result-owner.mjs runner/filesystem-id.mjs runner/cli-config.mjs runner/command-policy.mjs runner/wire-protocol.mjs runner/node-protocol.mjs runner/sync-client.mjs runner/sensitive-paths.mjs runner/ssh-config.mjs ./runner/
RUN for file in manager/*.mjs; do node --check "$file"; done
# node --check does not resolve imports; load the modules that pull in runner/ so a missing file fails the image build.
# Do not import manager/main.mjs: it reads a token and starts the server.
RUN node --input-type=module -e "await import('./manager/projects.mjs'); await import('./manager/assistant-computers.mjs'); await import('./manager/runner-client.mjs'); await import('./manager/compute-driver.mjs'); await import('./manager/node-sync.mjs'); await import('./manager/node-model-proxy.mjs'); await import('./manager/node-agent.mjs');"
COPY LICENSE ./LICENSE
COPY NOTICE ./NOTICE
RUN mkdir -p /data /opt/agent-tools /project-tools /skill-store /assistant-homes /tool-results /run/model-gateway /run/bot-runner && chown 10001:10001 /opt/agent-tools /project-tools /skill-store /assistant-homes /tool-results /run/model-gateway /run/bot-runner && chmod 700 /data && chmod 755 /opt/agent-tools /project-tools /skill-store /assistant-homes /tool-results /run/model-gateway && chmod 770 /run/bot-runner
USER 0:10001
CMD ["node", "manager/main.mjs"]
