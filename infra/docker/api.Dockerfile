# StaySync API and worker image (one image, two commands). Build from the repository root:
#   docker build -f infra/docker/api.Dockerfile -t staysync-api .

FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
# Only the API workspace's dependencies (with dev tools for the build); scripts run later.
RUN npm ci --workspace @staysync/api --include-workspace-root=false --ignore-scripts

FROM deps AS build
COPY apps/api apps/api
WORKDIR /app/apps/api
# Generate the client, compile, and download the migration engine now (so deploys do not depend on it later).
RUN npx prisma generate && npx tsc -p tsconfig.build.json && npx prisma migrate diff --from-empty --to-schema prisma/schema.prisma --script > /dev/null

# Image used once per deploy to apply migrations (has the Prisma CLI).
FROM build AS migrate
ENV NODE_ENV=production
CMD ["npx", "prisma", "migrate", "deploy"]

FROM node:24-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
# Native modules (argon2, sharp) ship prebuilt binaries for linux-musl, so no install scripts are needed.
RUN npm ci --workspace @staysync/api --include-workspace-root=false --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/apps/api/dist apps/api/dist
COPY --from=build /app/apps/api/prisma apps/api/prisma
WORKDIR /app/apps/api
# Photos are written here (mount a volume); the process runs as the unprivileged "node" user.
RUN mkdir -p storage/photos && chown -R node:node storage
USER node
ENV PHOTO_STORAGE_DIR=/app/apps/api/storage/photos
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD node -e "fetch('http://127.0.0.1:3000/api/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]
