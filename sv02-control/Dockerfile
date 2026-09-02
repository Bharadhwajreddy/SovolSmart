# Optional: the README's primary path is systemd, which is lighter on a Pi.
# This is here if you would rather run in a container.
FROM node:22-alpine

WORKDIR /app

# Copy manifests first so `npm ci` is cached when only source changes.
COPY package*.json ./
RUN npm ci --omit=dev

COPY server ./server
COPY public ./public

# Anomaly log lives here; mount a volume to keep it across rebuilds.
RUN mkdir -p /app/data && chown -R node:node /app
USER node

ENV PORT=8088
EXPOSE 8088

# The container must be able to reach both OctoPrint and the phone camera on
# your LAN, so run it with `--network host` (see docker-compose.yml).
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||8088)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.js"]
