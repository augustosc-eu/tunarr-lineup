# Tunarr Lineup companion: the Lineup interface plus a narrow same-origin
# proxy to Tunarr. TUNARR_URL is read at runtime by the server only; it is
# never baked into the image or the browser bundle.

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
# Lifecycle scripts are only needed by the hosted Cloudflare toolchain.
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY . .
RUN npm run build:local

FROM node:22-alpine AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000
WORKDIR /app
# The server has no runtime dependencies; only the built output is shipped.
COPY --from=build /app/dist-server ./dist-server
COPY --from=build /app/dist-local ./dist-local
RUN printf '{"type":"module","private":true}\n' > package.json
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "dist-server/main.js"]
