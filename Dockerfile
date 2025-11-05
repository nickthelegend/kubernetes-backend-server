FROM node:18-alpine

WORKDIR /app

COPY package.json package-lock.json* ./

COPY server.js ./

EXPOSE 8080

CMD ["node", "server.js"]