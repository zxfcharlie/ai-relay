FROM node:20-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY server ./server
COPY public ./public

ENV PORT=8511
ENV DATA_DIR=/app/data
EXPOSE 8511

VOLUME ["/app/data"]

CMD ["node", "server/index.js"]
