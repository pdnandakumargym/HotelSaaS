# StaySync web app + HTTPS edge (Caddy). Serves the Angular build and proxies /api to the API container.
#   docker build -f infra/docker/web.Dockerfile -t staysync-web .

FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci --workspace @staysync/web --include-workspace-root=false --ignore-scripts
COPY apps/web apps/web
WORKDIR /app/apps/web
RUN npx ng build --configuration production

FROM caddy:2.10-alpine
COPY infra/caddy/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/apps/web/dist/web/browser /srv
