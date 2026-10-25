# Node 24 ships the built-in node:sqlite module, so no native build tools are needed.
FROM node:24-alpine

ENV NODE_ENV=production \
    PORT=3000 \
    DB_FILE=/app/data/projectgroepen.db

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server.js ./
COPY src ./src
COPY views ./views
COPY public ./public

# The data directory is owned by the unprivileged user, so a fresh volume mounted here is writable.
RUN mkdir -p /app/data && chown -R node:node /app/data
VOLUME ["/app/data"]

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT}/healthz || exit 1

CMD ["node", "server.js"]
