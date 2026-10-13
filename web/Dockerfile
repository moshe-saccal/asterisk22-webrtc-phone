# syntax=docker/dockerfile:1
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json tsconfig.server.json vite.config.ts index.html ./
COPY public ./public
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:24-slim
ENV NODE_ENV=production \
    HTTPS_PORT=8443 \
    HTTP_PORT=8080 \
    STATIC_DIR=/app/dist/client
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/dist ./dist
EXPOSE 8443 8080
# Starts as root only to read the TLS key, then drops to the "node" user.
HEALTHCHECK --interval=15s --timeout=4s --start-period=10s --retries=3 \
  CMD node -e "require('https').get({host:'127.0.0.1',port:8443,path:'/healthz',rejectUnauthorized:false},r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"
CMD ["node", "dist/server/server.js"]
