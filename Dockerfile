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
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
    CMD nexus --help > /dev/null || exit 1
ENTRYPOINT ["nexus"]
CMD ["--help"]
