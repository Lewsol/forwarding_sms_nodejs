FROM node:20-bookworm-slim AS deps

ENV NODE_ENV=production \
    DEBIAN_FRONTEND=noninteractive \
    NPM_CONFIG_AUDIT=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_UPDATE_NOTIFIER=false

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
  && npm cache clean --force

FROM node:20-bookworm-slim AS runtime

ENV NODE_ENV=production \
    DEBIAN_FRONTEND=noninteractive \
    NPM_CONFIG_AUDIT=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_UPDATE_NOTIFIER=false

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends udev \
  && rm -rf /var/lib/apt/lists/*

COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY src ./src
COPY public ./public
COPY config.example.json ./

RUN mkdir -p logs data

EXPOSE 3000

CMD ["node", "src/index.js"]
