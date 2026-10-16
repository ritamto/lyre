FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY server.js ./
COPY public ./public
ENV NODE_ENV=production
EXPOSE 8080
USER node
CMD ["node", "server.js"]