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

# 2.1.2+: The base stage is now only used by deps/builder. Runtime
# ffmpeg with NVENC support is installed in the Debian-based runner
# stage below. Previous attempts (BtbN at 2.1.0, JVS static at 2.1.1)
# all hit the same wall — every linux ffmpeg distribution that
# ships NVENC is glibc-linked, but Alpine uses musl. The bridge
# attempts (gcompat, BtbN-on-Alpine) couldn't satisfy libmvec /
# fcntl64 / vector cosine symbols. The clean fix is to build on a
# distro that natively uses glibc + nvidia-container-runtime's
# library injection points.

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
# 2.1.2+: Debian-bookworm runner (was Alpine before). Switch needed
# because every NVENC-capable ffmpeg distribution for linux is
# glibc-linked, and Alpine's musl can't load them — even with
# gcompat the dynamic-loader-level symbols (libmvec, _ZGVbN2v_cos)
# stay missing. nvidia-container-runtime also injects driver libs
# into /usr/lib/x86_64-linux-gnu (Debian's ld search path), so the
# host GPU is visible to the container natively, no extra setup.
FROM node:24-bookworm-slim AS runner
WORKDIR /app

ARG APP_VERSION
LABEL org.opencontainers.image.title="FrameComment"
LABEL org.opencontainers.image.description="Video review and approval platform"
LABEL org.opencontainers.image.source="https://github.com/DragosOnisei/FrameComment"
LABEL org.opencontainers.image.version="${APP_VERSION}"
LABEL org.opencontainers.image.licenses="MIT"

ENV NODE_ENV=production \
    DEBIAN_FRONTEND=noninteractive

# Base runtime tools (curl for healthchecks, ca-certs for HTTPS,
# fonts/fontconfig for ffmpeg text drawing, gosu replaces alpine's
# su-exec in the entrypoint).
RUN apt-get update && apt-get install -y --no-install-recommends \
        bash curl ca-certificates fontconfig fonts-dejavu-core \
        gnupg openssl gosu xz-utils procps \
    && ln -s /usr/sbin/gosu /usr/local/bin/su-exec \
    && rm -rf /var/lib/apt/lists/*

# 2.1.2+: jellyfin-ffmpeg7 from Jellyfin's official Debian repo.
# Compiled with --enable-nvenc --enable-vaapi --enable-libvpl
# (QSV) + all the standard codec libs. Same binary that ships in
# production Jellyfin servers — extensively tested for NVENC.
# Installed to /usr/lib/jellyfin-ffmpeg/{ffmpeg,ffprobe}; we
# symlink to /usr/local/bin so the worker finds it in $PATH.
RUN mkdir -p /etc/apt/keyrings \
    && curl -fsSL https://repo.jellyfin.org/jellyfin_team.gpg.key \
        | gpg --dearmor -o /etc/apt/keyrings/jellyfin.gpg \
    && echo "deb [signed-by=/etc/apt/keyrings/jellyfin.gpg] https://repo.jellyfin.org/debian bookworm main" \
        > /etc/apt/sources.list.d/jellyfin.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends jellyfin-ffmpeg7 \
    && ln -sf /usr/lib/jellyfin-ffmpeg/ffmpeg  /usr/local/bin/ffmpeg \
    && ln -sf /usr/lib/jellyfin-ffmpeg/ffprobe /usr/local/bin/ffprobe \
    && rm -rf /var/lib/apt/lists/* \
    && echo "jellyfin-ffmpeg installed — HW encoders available:" \
    && /usr/local/bin/ffmpeg -hide_banner -encoders 2>/dev/null | grep -E "nvenc|vaapi|qsv" || true

# Python for Apprise notifications (unchanged behaviour from Alpine
# stage; venv layout identical).
RUN apt-get update && apt-get install -y --no-install-recommends \
        python3 python3-venv python3-pip \
    && python3 -m venv /opt/apprise-venv \
    && /opt/apprise-venv/bin/pip install --no-cache-dir --timeout=120 --upgrade pip \
    && /opt/apprise-venv/bin/pip install --no-cache-dir --timeout=120 apprise==1.9.9 \
    && apt-get remove -y python3-pip \
    && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*

ENV APPRISE_PYTHON=/opt/apprise-venv/bin/python3

ARG TARGETPLATFORM
ARG TARGETARCH
RUN echo "Building for: $TARGETPLATFORM ($TARGETARCH)" && uname -a

# App user (UID 911, remappable via PUID/PGID). Debian syntax
# replaces alpine's `addgroup`/`adduser` busybox variants. We
# create the user without a home directory because WORKDIR /app
# already exists and is the target home.
RUN groupadd -g 911 app \
    && useradd -u 911 -g app -d /app -s /bin/bash -M app

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
    chmod -R a+rX /app && \
    # 2.1.4+: Prisma's CLI writes a lock/metadata file under
    # node_modules/@prisma/engines on first `migrate deploy` run.
    # When the container is invoked with `user: '568:568'` (typical
    # on TrueNAS SCALE Apps) the runtime UID doesn't own this path
    # — owned by UID 911 from build time — and `prisma migrate
    # deploy` aborts with "Can't write to /app/node_modules/@prisma/
    # engines". Granting world-write on that subtree fixes it for
    # any deployment UID without baking 568 (or any other host's
    # convention) into the image.
    chmod -R a+w /app/node_modules/@prisma

ENV PUID=1000 PGID=1000

HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD node -e "require('http').get('http://localhost:4321/api/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})" || exit 1

EXPOSE 4321
ENV PORT=4321 HOSTNAME="0.0.0.0"

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["npm", "start"]
