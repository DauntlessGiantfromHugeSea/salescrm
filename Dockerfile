# Gemeinsames Image für API und Worker. Beide Prozesse teilen denselben Code;
# was läuft, entscheidet das Startkommando in docker-compose.yml.

FROM node:22-alpine AS base
WORKDIR /app
RUN apk add --no-cache openssl dumb-init

# --- Abhängigkeiten ---
FROM base AS deps
COPY package.json package-lock.json .npmrc ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci

# --- Build ---
FROM deps AS build
COPY packages/shared packages/shared
COPY apps/api apps/api
COPY apps/web apps/web
RUN npx prisma generate --schema apps/api/prisma/schema.prisma \
 && npm run build -w @salescrm/shared \
 && npm run build -w @salescrm/api \
 && npm run build -w @salescrm/web

# --- Laufzeit ---
FROM base AS runtime
ENV NODE_ENV=production

COPY package.json package-lock.json .npmrc ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
# Nur Produktionsabhängigkeiten; das Frontend ist zu diesem Zeitpunkt statisch.
RUN npm ci --omit=dev --workspace @salescrm/api --workspace @salescrm/shared --include-workspace-root

COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/apps/api/dist apps/api/dist
COPY --from=build /app/apps/api/prisma apps/api/prisma
COPY --from=build /app/node_modules/.prisma node_modules/.prisma
COPY --from=build /app/node_modules/@prisma/client node_modules/@prisma/client

# Nicht als root laufen.
USER node

# dumb-init leitet SIGTERM korrekt weiter, damit laufende Jobs sauber enden.
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "apps/api/dist/server.js"]
