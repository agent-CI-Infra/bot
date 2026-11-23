FROM node:22-bookworm-slim
WORKDIR /app
COPY manager ./manager
COPY runner/notes.mjs runner/note-path.mjs runner/note-catalog.mjs runner/image-budget.mjs runner/result-owner.mjs runner/filesystem-id.mjs runner/cli-config.mjs ./runner/
RUN for file in manager/*.mjs; do node --check "$file"; done
# node --check does not resolve imports; load the modules that pull in runner/ so a missing file fails the image build.
# Do not import manager/main.mjs: it reads a token and starts the server.
RUN node --input-type=module -e "await import('./manager/projects.mjs'); await import('./manager/assistant-computers.mjs');"
COPY LICENSE ./LICENSE
COPY NOTICE ./NOTICE
RUN mkdir -p /data /opt/agent-tools && chown 10001:10001 /opt/agent-tools && chmod 700 /data && chmod 755 /opt/agent-tools
USER 0:10001
CMD ["node", "manager/main.mjs"]
