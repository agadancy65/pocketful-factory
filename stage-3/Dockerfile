# Pocketful stage 3 service. No runtime dependencies beyond Node.js itself: the
# service and the browser screens use only the Node standard library and the
# files under src/, so the image needs no install step and no outbound network
# access at run time.
FROM node:22-alpine

ENV NODE_ENV=production
ENV PORT=8080

WORKDIR /app

COPY package.json ./
COPY src/ ./src/

EXPOSE 8080
USER node

CMD ["node", "src/server.js"]