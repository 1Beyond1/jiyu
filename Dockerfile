FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json vite.config.ts index.html ./
COPY src ./src
COPY public ./public
COPY server ./server
RUN npm run build && npm test && npm prune --omit=dev

FROM node:24-bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends poppler-utils tesseract-ocr tesseract-ocr-chi-sim tesseract-ocr-eng && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production JIYU_HOST=0.0.0.0 JIYU_PORT=3000 JIYU_DATA_DIR=/data/live JIYU_BACKUP_DIR=/backups
WORKDIR /app
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/server ./server
COPY --from=build --chown=node:node /app/src/types.ts ./src/types.ts
COPY --from=build --chown=node:node /app/src/lib/collections.ts ./src/lib/collections.ts
COPY --from=build --chown=node:node /app/src/lib/submission-naming.ts ./src/lib/submission-naming.ts
COPY --from=build --chown=node:node /app/package*.json ./
COPY --chown=node:node LICENSE ./LICENSE
RUN mkdir -p /data /backups && chown node:node /data /backups
USER node
VOLUME ["/data", "/backups"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=15s CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["npm", "start"]
