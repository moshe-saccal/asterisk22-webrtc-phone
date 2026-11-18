# Containerised end-to-end tests: Chromium with fake camera/microphone, on the
# same Docker network as Asterisk and the web phone.
FROM mcr.microsoft.com/playwright:v1.64.0-noble
WORKDIR /e2e
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY playwright.config.ts ./
COPY tests ./tests
CMD ["npx", "playwright", "test"]
