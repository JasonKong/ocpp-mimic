# syntax=docker/dockerfile:1
# The ocpp-mimic image: the npm package (pnpm pack:release) installed on Node.js 24.
# The package is plain JavaScript, so it is built once on the build platform and
# only installed per target platform.

FROM --platform=$BUILDPLATFORM node:24-slim AS package
WORKDIR /src
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile && pnpm pack:release

FROM node:24-slim
LABEL org.opencontainers.image.title="ocpp-mimic" \
      org.opencontainers.image.description="OCPP 1.6J, 2.0.1 and 2.1 charge point simulator" \
      org.opencontainers.image.source="https://github.com/JasonKong/ocpp-mimic" \
      org.opencontainers.image.licenses="BUSL-1.1"
ENV NODE_ENV=production
RUN --mount=type=bind,from=package,source=/src/release,target=/release \
    npm install --global --no-audit --no-fund /release/ocpp-mimic-*.tgz \
    && npm cache clean --force \
    && mkdir -p /data && chown node:node /data
USER node
WORKDIR /data
VOLUME /data
EXPOSE 7300 9100
ENTRYPOINT ["ocpp-mimic"]
CMD ["serve", "--host", "0.0.0.0", "--store", "/data/ocpp-mimic.db"]
