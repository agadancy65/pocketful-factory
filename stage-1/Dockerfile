# Pocketful stage 1 service. No runtime dependencies beyond Node.js itself:
# the service uses only the Node standard library, so the image has no install
# step and needs no outbound network access at run time.
FROM node:22-alpine

ENV NODE_ENV=production
ENV PORT=8080

WORKDIR /app

COPY package.json ./
COPY src/ ./src/

EXPOSE 8080
USER node

CMD ["node", "src/server.js"]