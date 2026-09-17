FROM node:22-slim AS dependencies
WORKDIR /opt/nexus
COPY package.json ./
COPY apps/cli ./apps/cli
COPY packages ./packages
# Use npm install until the monorepo lockfile is repaired.
RUN npm install --omit=dev --ignore-scripts --no-audit --no-fund \
    && npm cache clean --force

FROM node:22-slim AS runtime
ENV NODE_ENV=production
WORKDIR /opt/nexus
COPY --from=dependencies --chown=node:node /opt/nexus ./
RUN ln -s /opt/nexus/apps/cli/bin.mjs /usr/local/bin/nexus \
    && chmod +x /opt/nexus/apps/cli/bin.mjs \
    && mkdir /workspace && chown node:node /workspace
USER node
WORKDIR /workspace
# HEALTHCHECK probes binary load + package.json parse via the same fast path
# bin.mjs uses for `nexus --version`. `nexus --help` would dispatch through the
# CLI parser (heavier) and is also the default CMD, so reusing it for the
# healthcheck risks masking runtime regressions when the parser is broken.
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
    CMD nexus --version > /dev/null || exit 1
ENTRYPOINT ["nexus"]
# Default CMD prints help so `docker run nexus-test` exits 0 with usage info.
# For a long-running container (smoke test, dev shell), override CMD, e.g.:
#   docker run --rm -d nexus-test sleep infinity
CMD ["--help"]