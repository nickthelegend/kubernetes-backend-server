FROM node:18-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

COPY server.js ./

EXPOSE 8080

CMD ["node", "server.js"]