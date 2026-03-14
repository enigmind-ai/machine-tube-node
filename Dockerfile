FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine
WORKDIR /app
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/dist ./dist
ENV MT_NODE_PORT=43110
ENV MT_NODE_DATA_DIR=/data
EXPOSE 43110
CMD ["node", "dist/index.js"]