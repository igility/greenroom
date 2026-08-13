# Greenroom sidecar — single container serving the review store, the reviewer
# shell, and hosted Storybook builds. Build from the greenroom/ workspace root:
#   docker build -t greenroom .
#   docker run -p 4788:4788 -v greenroom-data:/data \
#     -e GREENROOM_ADMIN_KEY=... -e GREENROOM_PUBLIC_URL=https://review.example.com greenroom
FROM node:22-bookworm AS build
WORKDIR /app
RUN corepack enable
COPY . .
# Install and build only the two packages the sidecar needs at runtime, then
# produce a self-contained deployable (server + its prod deps, incl. the built
# native better-sqlite3 binding and the bundled shared package).
RUN pnpm install --filter @igility/greenroom-server... \
 && pnpm --filter @igility/greenroom-shared build \
 && pnpm --filter @igility/greenroom-server build \
 && pnpm --filter @igility/greenroom-server deploy --legacy --prod /out

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    GREENROOM_DATA_DIR=/data \
    GREENROOM_PORT=4788
COPY --from=build /out ./
RUN mkdir -p /data
VOLUME /data
EXPOSE 4788
CMD ["node", "dist/cli.js", "serve"]
