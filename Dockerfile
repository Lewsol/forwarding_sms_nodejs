FROM alpine:3.22 AS deps

ENV NODE_ENV=production \
    NPM_CONFIG_AUDIT=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_UPDATE_NOTIFIER=false

WORKDIR /app

RUN apk add --no-cache nodejs npm python3 make g++

COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
  && npm cache clean --force

FROM alpine:3.22 AS runtime

ENV NODE_ENV=production

WORKDIR /app

RUN apk add --no-cache nodejs eudev

COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY src ./src
COPY public ./public
COPY config.example.json ./

RUN mkdir -p logs data

EXPOSE 3000

CMD ["node", "src/index.js"]
