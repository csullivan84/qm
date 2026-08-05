FROM node:26.5.1-alpine@sha256:221f4d1edb150c0ddf3c61c1f053cd3a59ee0fe42f54cb687a7db24e97da6c46 AS build
RUN npm install --global npm@12.0.2
WORKDIR /app
ARG WEB_UI_BASE=/
ENV WEB_UI_BASE=$WEB_UI_BASE
COPY plugins/web-ui/package.json plugins/web-ui/package-lock.json plugins/web-ui/.npmrc ./
RUN npm ci
COPY plugins/web-ui/index.html plugins/web-ui/vite.config.ts plugins/web-ui/tsconfig.json ./
COPY plugins/web-ui/src ./src
COPY plugins/chassis/src /chassis/src
RUN npm run build

FROM node:26.5.1-alpine@sha256:221f4d1edb150c0ddf3c61c1f053cd3a59ee0fe42f54cb687a7db24e97da6c46
RUN npm install --global npm@12.0.2
WORKDIR /app
COPY plugins/web-ui/package.json plugins/web-ui/package-lock.json plugins/web-ui/.npmrc ./
RUN npm ci --omit=dev && rm package-lock.json \
  && rm -rf /root/.npm /tmp/node-compile-cache
COPY plugins/web-ui/server ./server
COPY plugins/chassis/src /chassis/src
COPY --from=build /app/dist-web ./dist-web

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080
USER node
CMD ["node", "server/index.ts"]
