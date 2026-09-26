# Backend: REST API + bot workers. Kept small for 1 GB VMs: slim Node plus only Playwright's
# Chromium headless shell and the libraries it needs (no full Chrome, Firefox or WebKit).
FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    DATA_DIR=/data \
    PORT=8080

# Only the libraries the headless shell links against, plus one font family. Playwright's
# --with-deps would add an X server, Mesa/LLVM and fonts for every script (~600 MB more).
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      libasound2 libatk-bridge2.0-0 libatk1.0-0 libatspi2.0-0 libdrm2 libgbm1 libglib2.0-0 \
      libnspr4 libnss3 libx11-6 libxcb1 libxcomposite1 libxdamage1 libxext6 libxfixes3 libxi6 \
      libxkbcommon0 libxrandr2 fontconfig fonts-liberation \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
 && npx playwright install --only-shell chromium \
 && rm -rf /ms-playwright/ffmpeg-* \
 && npm cache clean --force \
 && rm -rf /root/.cache /root/.npm /tmp/*

COPY src ./src

ARG APP_VERSION=dev
ENV APP_VERSION=$APP_VERSION

# Same user id as before (1001), so files in deploy/certs keep working.
RUN useradd --uid 1001 --create-home --shell /usr/sbin/nologin pwuser \
 && mkdir -p /data && chown -R pwuser:pwuser /data
USER pwuser
VOLUME /data
EXPOSE 8080

HEALTHCHECK --interval=60s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 8080) + '/api/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"

CMD ["node", "src/server/index.js"]
