# syntax=docker/dockerfile:1
# The build stage runs on the builder's own architecture: its output is plain JavaScript and
# pure-JS dependencies, so nothing there depends on the target platform, and compiling under
# QEMU emulation is slow (and stalls with TypeScript's native binary). Only the runtime stage
# is built per platform.
# The official Node image; pass --build-arg NODE_IMAGE=public.ecr.aws/docker/library/node:22-alpine
# (the same image, mirrored) where Docker Hub limits anonymous pulls.
ARG NODE_IMAGE=node:22-alpine
FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json tsup.config.ts ./
COPY src ./src
RUN pnpm build && pnpm prune --prod

FROM ${NODE_IMAGE}
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# The website, served under / by `hosted`: the same files the Pages site is made of.
COPY site ./site
COPY docs/demo ./site/demo
COPY docs/brand ./site/brand
COPY docs/video ./site/video
COPY docs/brief/example.html ./site/brief/index.html
COPY docs/brief/brief.png ./site/brief/brief.png
# `hosted` keeps its connections here; mount a volume on it to keep them across restarts.
RUN mkdir -p /data && chown node:node /data
ENV SHOPWARE_MCP_SITE_DIR=/app/site SHOPWARE_MCP_DATA_DIR=/data
USER node
EXPOSE 3333
# Default: Streamable HTTP on 0.0.0.0:3333. For stdio run with `-i` and override CMD with no args.
# For many shops behind OAuth: CMD ["hosted", "--host", "0.0.0.0", "--port", "3333"].
ENTRYPOINT ["node", "dist/index.js"]
CMD ["--http", "--host", "0.0.0.0", "--port", "3333"]
