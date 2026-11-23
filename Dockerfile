FROM node:24-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY tsconfig.json ./
COPY src ./src
COPY public ./public

RUN npm install --no-save typescript @types/node @types/express @types/cookie-parser @types/node-cron @types/qrcode \
  && npx tsc \
  && npm uninstall --no-save typescript @types/node @types/express @types/cookie-parser @types/node-cron @types/qrcode

ENV NODE_ENV=production
ENV PORT=3000
ENV DATA_DIR=/app/data

EXPOSE 3000

CMD ["node", "dist/index.js"]
