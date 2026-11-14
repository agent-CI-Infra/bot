FROM node:22-bookworm-slim
WORKDIR /app
COPY manager ./manager
COPY runner/notes.mjs runner/note-path.mjs runner/note-catalog.mjs ./runner/
RUN for file in manager/*.mjs; do node --check "$file"; done
COPY LICENSE ./LICENSE
COPY NOTICE ./NOTICE
RUN mkdir -p /data /opt/agent-tools && chmod 700 /data && chmod 755 /opt/agent-tools
USER 0:10001
CMD ["node", "manager/main.mjs"]
