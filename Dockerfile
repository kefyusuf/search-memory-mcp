FROM node:24-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY tsconfig.json ./
COPY src/ src/
RUN npm run build

FROM node:24-slim

WORKDIR /app

ENV NODE_ENV=production
ENV CACHE_DB_PATH=/app/data/websearch_cache.db
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

COPY package.json package-lock.json ./
RUN --mount=type=secret,id=build_ca \
  if [ -f /run/secrets/build_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/build_ca; fi \
  && npm ci --omit=dev --ignore-scripts \
  && npx playwright install --with-deps chromium \
  && npm cache clean --force

# Initialize the required native binding skipped by npm ci --ignore-scripts.
RUN --mount=type=secret,id=build_ca \
  if [ -f /run/secrets/build_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/build_ca; fi \
  && npm rebuild better-sqlite3 \
  && npm cache clean --force

COPY --from=build /app/build ./build

RUN mkdir -p /app/data

CMD ["node", "build/index.js"]
