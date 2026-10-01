FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production PORT=8080 PROBE_ADAPTER_MODULE=/app/production.mjs
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --chown=node:node lib ./lib
COPY --chown=node:node server.mjs production.mjs ./
USER node
EXPOSE 8080
CMD ["node", "server.mjs"]
