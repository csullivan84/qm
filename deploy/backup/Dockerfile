FROM node:26.5.1-alpine3.23@sha256:2a633e101381371ba148c7c212bf447c00cd267d814b708a9fe52c4984204729

RUN npm install --global npm@12.0.2 \
  && apk add --no-cache ca-certificates postgresql18-client=18.4-r0 \
  && pg_dump --version | grep -Eq '^pg_dump \(PostgreSQL\) 18\.4' \
  && pg_restore --version | grep -Eq '^pg_restore \(PostgreSQL\) 18\.4'

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm audit --omit=dev --audit-level=moderate \
  && rm -rf /root/.npm /tmp/node-compile-cache

COPY src ./src
COPY tsconfig.json ./

ENV NODE_ENV=production
USER node
ENTRYPOINT ["node", "/app/src/backup/worker-main.ts"]
