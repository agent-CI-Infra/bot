FROM node:22-bookworm-slim
# Common toolchains for reviewing and developing repositories. Repositories add their own system packages through the
# manager (a derived image) and user-level tools through their setup script; nothing inside the computer runs as root.
RUN apt-get update && apt-get install -y --no-install-recommends \
      git git-lfs ca-certificates openssh-client curl wget jq ripgrep file less procps \
      zip unzip xz-utils bzip2 patch make gcc g++ pkg-config sqlite3 \
      python3 python3-pip python3-venv python3-dev python-is-python3 \
    && pip3 install --break-system-packages --no-cache-dir uv \
    && corepack enable \
    && dpkg-query -W -f '${Package}\n' | sort > /tmp/image-packages \
    && mkdir -p /opt/bot && mv /tmp/image-packages /opt/bot/image-packages \
    && rm -rf /var/lib/apt/lists/*
RUN groupadd --gid 10001 project && useradd --uid 10001 --gid project --no-create-home project \
    && mkdir /workspace && chown project:project /workspace && chmod 700 /workspace
COPY runner/package.json runner/package-lock.json /opt/runner/
RUN cd /opt/runner && npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY runner /opt/runner
RUN for file in /opt/runner/*.mjs; do node --check "$file"; done
COPY LICENSE NOTICE /opt/licenses/
RUN chmod -R a-w /opt/runner /opt/bot
LABEL department.bot.toolchain="Node.js 22 (npm, corepack: pnpm/yarn), Python 3.11 (pip, venv, uv), gcc/g++/make, git, git-lfs, curl, wget, jq, ripgrep, sqlite3, zip/unzip"
USER 10001:10001
WORKDIR /workspace
CMD ["node", "/opt/runner/idle.mjs"]
