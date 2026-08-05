FROM node:26.5.1-alpine@sha256:221f4d1edb150c0ddf3c61c1f053cd3a59ee0fe42f54cb687a7db24e97da6c46

RUN npm install --global npm@12.0.2
WORKDIR /app

COPY plugins/auth/package.json plugins/auth/package-lock.json ./
RUN npm ci --omit=dev && rm -rf /root/.npm /tmp/node-compile-cache

COPY plugins/auth/src ./src
COPY plugins/chassis/src /chassis/src
COPY plugins/auth/tsconfig.json ./

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080
USER node
CMD ["node", "src/index.ts"]
