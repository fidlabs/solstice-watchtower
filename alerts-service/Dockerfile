# Node built-ins only: nothing to install, nothing to audit beyond the base image.
FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY src ./src
ENV NODE_ENV=production PORT=8080
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
CMD ["node", "src/server.mjs"]
