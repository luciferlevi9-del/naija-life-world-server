FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev --no-package-lock
COPY server.js ./
COPY data/lagos_nav.json ./data/lagos_nav.json
ENV PORT=8080 SAVE_FILE=/data/players.json
EXPOSE 8080
CMD ["node","server.js"]
