# Backend: REST API + bot workers. The Playwright image ships Chromium and its system libraries;
# its version must match the "playwright" dependency in package.json.
FROM mcr.microsoft.com/playwright:v1.56.1-noble

ENV NODE_ENV=production \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    DATA_DIR=/data \
    PORT=8080

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src

ARG APP_VERSION=dev
ENV APP_VERSION=$APP_VERSION

RUN mkdir -p /data && chown -R pwuser:pwuser /data
USER pwuser
VOLUME /data
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 8080) + '/api/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"

CMD ["node", "src/server/index.js"]
