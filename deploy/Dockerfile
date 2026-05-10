# ---- Build stage ----
FROM --platform=$BUILDPLATFORM node:20-alpine AS build

WORKDIR /app

ENV VITE_DEFAULT_API_URL=__VITE_DEFAULT_API_URL_PLACEHOLDER__
ENV VITE_API_PROXY_AVAILABLE=false
ENV VITE_DOCKER_DEPLOYMENT=true
ENV VITE_DOCKER_LEGACY_API_URL_USED=false

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

# ---- Production stage ----
FROM node:20-alpine

WORKDIR /app

ENV HOST=0.0.0.0
ENV PORT=3000
ENV DATA_DIR=/data
ENV DB_PATH=/data/app.sqlite3
ENV IMAGES_DIR=/data/images
ENV ENABLE_REGISTRATION=false
ENV MAX_UPLOAD_MB=600
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --from=build /app/dist ./dist
COPY --from=build /app/dist-server ./dist-server

VOLUME ["/data"]
EXPOSE 3000

CMD ["node", "dist-server/index.js"]
