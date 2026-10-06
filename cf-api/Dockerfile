FROM node:22-slim AS deps
WORKDIR /app
COPY package*.json ./
# sharp ships prebuilt binaries for linux/amd64 and arm64, so no toolchain is needed.
RUN npm ci --omit=dev

FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app

RUN apt-get update \
 && apt-get install -y --no-install-recommends curl \
 && rm -rf /var/lib/apt/lists/*

COPY --from=deps /app/node_modules ./node_modules
COPY package*.json ./
COPY src ./src
COPY migrations ./migrations

# Card photos live on a mounted volume, not in the image.
RUN mkdir -p storage/cards storage/thumbs storage/qr \
 && chown -R node:node /app/storage

USER node
EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -fsS http://localhost:4000/health || exit 1

CMD ["node", "src/server.js"]
