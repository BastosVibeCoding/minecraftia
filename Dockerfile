# Image du bot Minecraftia (Node 22, glibc pour les modules natifs : better-sqlite3, sqlite-vec, onnxruntime)
FROM node:22-bookworm AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
COPY test ./test
RUN npx tsc -p tsconfig.json && npm prune --omit=dev

FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
VOLUME ["/app/data"]
EXPOSE 7891 8765
CMD ["node", "dist/src/index.js"]
