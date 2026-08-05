FROM node:26.5.1-slim@sha256:5d3523cab52e98da5df1b0c8a3a64ca96d77fa435432219ce66ab8bafb704119

RUN npm install --global npm@12.0.2
WORKDIR /app

COPY plugins/admin/src ./src
COPY plugins/chassis/src /chassis/src
COPY plugins/admin/public ./public
COPY plugins/admin/tsconfig.json ./

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080
USER node
CMD ["node", "src/index.ts"]
