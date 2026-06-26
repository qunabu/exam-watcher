# Playwright base image ships Chromium + all system deps preinstalled.
FROM mcr.microsoft.com/playwright:v1.49.1-noble

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY watcher.js ./

# Ensure Xvfb is present (the Playwright image usually has it; install to be safe).
RUN apt-get update && apt-get install -y --no-install-recommends xvfb \
    && rm -rf /var/lib/apt/lists/*

# Render background worker — no port needed. Run headful under a virtual display
# so the site treats it like a real browser and keeps the session alive.
CMD ["xvfb-run", "-a", "--server-args=-screen 0 1280x1024x24", "node", "watcher.js"]
