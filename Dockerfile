# Playwright base image ships Chromium + all system deps preinstalled.
FROM mcr.microsoft.com/playwright:v1.49.1-noble

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY watcher.js ./

# Render background worker — no port needed.
CMD ["node", "watcher.js"]
