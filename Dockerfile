FROM node:22-alpine AS dependencies

WORKDIR /app

COPY package*.json ./

RUN npm install --omit=dev


FROM node:22-alpine AS runtime

RUN addgroup -S -g 10001 appgroup && \
    adduser -S -D -H -u 10001 -G appgroup appuser

WORKDIR /app

COPY --from=dependencies --chown=10001:10001 \
    /app/node_modules ./node_modules

COPY --chown=10001:10001 . .

ENV NODE_ENV=production
ENV PORT=3000

USER 10001:10001

EXPOSE 3000

CMD ["node", "src/server.js"]
