FROM node:22-alpine AS dependencies

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev && npm cache clean --force

FROM node:22-alpine AS runtime

RUN addgroup -S appgroup && adduser -S appuser -G appgroup

WORKDIR /app

COPY --from=dependencies --chown=appuser:appgroup /app/node_modules ./node_modules
COPY --chown=appuser:appgroup . .

ENV NODE_ENV=production
ENV PORT=3000

USER appuser

EXPOSE 3000

CMD ["node", "src/server.js"]
