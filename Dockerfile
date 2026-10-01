# Exact CLI installation fallback: official 1.18.34 image tag not verified.
FROM oven/bun:1.4.2
USER root
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates openssh-client \
    && rm -rf /var/lib/apt/lists/* \
    && BUN_INSTALL=/opt/cli bun install --global opencode-ai@1.18.34 \
    && /opt/cli/bin/opencode --version | grep -Fx '1.18.34' \
    && groupadd --gid 10001 opencode \
    && useradd --uid 10001 --gid 10001 --create-home --home-dir /home/opencode opencode \
    && chmod 0700 /home/opencode
ENV PATH="/opt/cli/bin:${PATH}" HOME=/home/opencode \
    XDG_CONFIG_HOME=/home/opencode/.config \
    XDG_DATA_HOME=/home/opencode/.local/share \
    XDG_STATE_HOME=/home/opencode/.local/state \
    XDG_CACHE_HOME=/home/opencode/.cache
COPY config /opt/bundle/config
COPY router /opt/bundle/router
COPY scripts /opt/bundle/scripts
COPY package.json /opt/bundle/package.json
USER 10001:10001
WORKDIR /workspace
ENTRYPOINT ["/bin/sh", "/opt/bundle/scripts/container-entrypoint.sh"]
