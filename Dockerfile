FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build
RUN npm prune --omit=dev

FROM node:24-alpine
RUN apk add --no-cache ffmpeg
WORKDIR /app
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/package-lock.json ./package-lock.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
ENV MT_NODE_PORT=43110
ENV MT_NODE_DATA_DIR=/data
ENV MT_NODE_INBOX_DIR=/videos
EXPOSE 43110
CMD ["node", "dist/index.js"]
