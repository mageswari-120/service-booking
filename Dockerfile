FROM node:20-alpine
RUN apk add --no-cache openssl

EXPOSE 3000

WORKDIR /app

COPY package.json package-lock.json* ./

# The build (remix vite:build) needs dev dependencies such as vite, so install
# everything first and prune after building.
RUN npm ci

COPY . .

RUN npx prisma generate && npm run build \
  && npm prune --omit=dev && npm cache clean --force

ENV NODE_ENV=production
ENV PORT=3000

# docker-start = prisma migrate deploy, then remix-serve on $PORT (3000). The
# Prisma client is generated above at build time, not on every start.
CMD ["npm", "run", "docker-start"]
