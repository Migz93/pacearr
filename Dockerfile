FROM node:22-trixie-slim AS deps
# better-sqlite3 may not have a prebuilt binary for every Node and CPU
# combination, so provide node-gyp's native build requirements in this stage.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install

FROM node:22-trixie-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:22-trixie-slim AS runtime
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends fonts-dejavu-core fontconfig gosu \
  && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
ENV PORT=9302
ENV DATA_DIR=/config
# Build metadata — overridden by CI workflows via --build-arg
ARG BUILD_CHANNEL=custom
ARG COMMIT_SHA=local
ENV BUILD_CHANNEL=$BUILD_CHANNEL
ENV COMMIT_SHA=$COMMIT_SHA
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY docker-entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
EXPOSE 9302
ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "dist/server/server/index.js"]
