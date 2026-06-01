# FrameComment - Multi-Architecture Docker Image
# Supports: amd64, arm64 | Security: non-root user via PUID/PGID

FROM node:24-alpine3.23 AS base

ARG TARGETPLATFORM
ARG TARGETARCH
ARG BUILDPLATFORM

# Install system dependencies + patch known CVEs
RUN apk update && apk upgrade --no-cache && \
    apk add --no-cache \
        openssl openssl-dev \
        ffmpeg ffmpeg-libs fontconfig ttf-dejavu \
        bash curl ca-certificates shadow su-exec \
    && apk add --no-cache --upgrade cjson libsndfile giflib orc zlib expat \
    && npm install -g npm@latest \
    && npm cache clean --force \
    && ffmpeg -version

# 2.1.1+: Swap stock alpine ffmpeg (no NVENC/QSV/VAAPI) for John Van
# Sickle's truly-static linux ffmpeg build which ships with NVENC
# support compiled in. We tried BtbN's "static" GPL build first
# (2.1.0) but it turned out to be dynamically linked to glibc and
# wouldn't run on Alpine even with gcompat — missing libmvec.so.1
# and fcntl64 symbols. JVS's build is statically linked against
# musl-compatible primitives so it runs cleanly on Alpine without
# any libc shim.
#   (a) amd64 only — the JVS static build is amd64-only,
#   (b) arm64 dev (Mac) keeps alpine ffmpeg + VideoToolbox via host,
#   (c) worker auto-detects available encoders + falls back to
#       libx264 if NVENC init fails, so this is purely opt-in
#       performance.
# JVS is the canonical Alpine-static ffmpeg distribution used by
# Plex / Jellyfin / Emby docs, hosted at johnvansickle.com/ffmpeg.
# The release tarball at this URL is updated periodically; the
# binary contained always includes h264_nvenc / hevc_nvenc.
RUN if [ "$(uname -m)" = "x86_64" ]; then \
        apk add --no-cache --virtual .ffmpeg-build-deps xz && \
        curl -fsSL --retry 3 --retry-delay 5 -o /tmp/ffmpeg.tar.xz \
            "https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz" && \
        mkdir -p /tmp/ffmpeg-extract && \
        tar -xf /tmp/ffmpeg.tar.xz -C /tmp/ffmpeg-extract --strip-components=1 && \
        cp /tmp/ffmpeg-extract/ffmpeg  /usr/local/bin/ffmpeg && \
        cp /tmp/ffmpeg-extract/ffprobe /usr/local/bin/ffprobe && \
        chmod 0755 /usr/local/bin/ffmpeg /usr/local/bin/ffprobe && \
        rm -rf /tmp/ffmpeg.tar.xz /tmp/ffmpeg-extract && \
        apk del --no-cache .ffmpeg-build-deps && \
        echo "JVS static ffmpeg installed — testing run + encoders:" && \
        /usr/local/bin/ffmpeg -version | head -1 && \
        /usr/local/bin/ffmpeg -hide_banner -encoders 2>/dev/null | grep -E "nvenc|vaapi|qsv" || true; \
    else \
        echo "Skipping JVS ffmpeg on non-amd64 ($(uname -m)) — alpine ffmpeg keeps the default behaviour"; \
    fi

# === Dependencies ===
FROM base AS deps
WORKDIR /app

COPY --link package.json package-lock.json* ./
COPY --link prisma ./prisma

RUN --mount=type=cache,target=/root/.npm \
    npm ci --legacy-peer-deps

RUN cp -R node_modules /tmp/prod_node_modules

RUN npm audit --audit-level=high || \
    (echo "SECURITY: High/critical vulnerabilities found!" && exit 1)

# === Builder ===
FROM base AS builder
WORKDIR /app

COPY --from=deps --link /app/node_modules ./node_modules
COPY --link . .

RUN npx prisma generate

ARG APP_VERSION
ENV NEXT_PUBLIC_APP_VERSION=${APP_VERSION}
ENV SKIP_ENV_VALIDATION=1
ENV NEXT_PHASE=phase-production-build
RUN npm run build

# === Production ===
FROM base AS runner
WORKDIR /app

ARG APP_VERSION
LABEL org.opencontainers.image.title="FrameComment"
LABEL org.opencontainers.image.description="Video review and approval platform"
LABEL org.opencontainers.image.source="https://github.com/DragosOnisei/FrameComment"
LABEL org.opencontainers.image.version="${APP_VERSION}"
LABEL org.opencontainers.image.licenses="MIT"

ENV NODE_ENV=production


# Python for Apprise notifications
RUN apk add --no-cache python3 py3-pip \
    && python3 -m venv /opt/apprise-venv \
    && /opt/apprise-venv/bin/pip install --no-cache-dir --timeout=120 --upgrade pip \
    && /opt/apprise-venv/bin/pip install --no-cache-dir --timeout=120 apprise==1.9.9 \
    && apk del --no-cache py3-pip

ENV APPRISE_PYTHON=/opt/apprise-venv/bin/python3

ARG TARGETPLATFORM
ARG TARGETARCH
RUN echo "Building for: $TARGETPLATFORM ($TARGETARCH)" && uname -a

# App user (UID 911, remappable via PUID/PGID)
RUN addgroup -g 911 app && adduser -D -u 911 -G app -h /app app

# Copy production files
COPY --from=deps --link /tmp/prod_node_modules ./node_modules
COPY --from=builder --link /app/public ./public
COPY --from=builder --link /app/.next ./.next
COPY --from=builder --link /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder --link /app/node_modules/@prisma ./node_modules/@prisma
COPY --from=builder --link /app/prisma ./prisma
COPY --from=builder --link /app/src ./src
COPY --from=builder --link /app/package.json ./package.json
COPY --from=builder --link /app/tsconfig.json ./tsconfig.json
COPY --from=builder --link /app/next.config.js ./next.config.js
COPY --from=builder --link /app/worker.mjs ./worker.mjs
COPY --link --chmod=0755 docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
COPY --link previewlut.cube /usr/share/ffmpeg/previewlut.cube

RUN chmod a+r /usr/share/ffmpeg/previewlut.cube && \
    chown -R app:app /app && \
    chmod -R a+rX /app

ENV PUID=1000 PGID=1000

HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD node -e "require('http').get('http://localhost:4321/api/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})" || exit 1

EXPOSE 4321
ENV PORT=4321 HOSTNAME="0.0.0.0"

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["npm", "start"]
