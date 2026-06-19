# syntax=docker/dockerfile:1.7

# ─────────────────────────────────────────────
# Stage 1: Build (esbuild – bundle src/ only)
# ─────────────────────────────────────────────
FROM --platform=$BUILDPLATFORM node:24-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN --mount=type=cache,target=/root/.npm npm ci

COPY src ./src

# All node_modules remain external – only the src/ code is bundled.
# ESM format required due to "type": "module" in package.json.
RUN npx esbuild src/index.js \
    --bundle \
    --platform=node \
    --format=esm \
    --packages=external \
    --outfile=dist/server.js

# ─────────────────────────────────────────────
# Stage 2: Runtime
# ─────────────────────────────────────────────
FROM node:24-alpine

WORKDIR /app

ENV NODE_ENV=production

ARG USER_ID=1000
ARG GROUP_ID=1000

# Install production dependencies only (no devDependencies)
COPY package*.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev

# Copy bundled code (no src/ needed at runtime)
COPY --from=builder /app/dist/server.js ./server.js

RUN chown -R ${USER_ID}:${GROUP_ID} /app

USER ${USER_ID}:${GROUP_ID}

EXPOSE 3000

CMD ["node", "server.js"]
