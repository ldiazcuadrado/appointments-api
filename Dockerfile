# syntax=docker/dockerfile:1

FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY prisma.config.ts tsconfig.json tsconfig.build.json ./
COPY prisma ./prisma
COPY src ./src
RUN npm run build
RUN npm prune --omit=dev

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/prisma ./prisma
COPY --from=build --chown=node:node /app/prisma.config.ts /app/package.json ./
COPY --chown=node:node docker-entrypoint.sh ./
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health/live').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", "dist/src/server.js"]
