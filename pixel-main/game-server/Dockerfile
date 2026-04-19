FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY src/ ./src/
COPY manifest.json ./manifest.json
EXPOSE 3000
CMD ["node", "src/index.js"]
