# ==========================================
# STAGE 1: Build & Install Dependencies
# ==========================================
FROM node:22-alpine AS builder

WORKDIR /app

# Copy dependency manifests
COPY package*.json ./

# Install production-only dependencies (no jest/supertest in the runtime image)
RUN npm ci --omit=dev

# Copy application source code
COPY server.js ./
COPY lib ./lib
COPY public ./public

# ==========================================
# STAGE 2: Test (build-time gate)
# ==========================================
# Needs devDependencies, so a full `npm ci` rather than the builder's
# --omit=dev. RUN, not CMD: the suite has to execute during
# `docker build --target test` so a failure fails the build. A CMD would
# only run on container start, letting the build pass with a red suite.
FROM node:22-alpine AS test

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY server.js ./
COPY lib ./lib
COPY public ./public
COPY tests ./tests

ENV NODE_ENV=test
RUN npm test

# ==========================================
# STAGE 3: Production Runtime
# ==========================================
# Not derived from `test`, so the default `docker build .` (and compose)
# still produce the runtime image without running the suite; CI gates
# explicitly via --target test.
FROM node:22-alpine AS runner

WORKDIR /app

# Set production environment
ENV NODE_ENV=production
ENV PORT=3000

# Base-image hardening, both driven by findings from the Trivy gate:
#  - apk upgrade picks up the patched openssl (CVE-2026-14456).
#  - The bundled npm CLI vendors its own dependency tree (tar, pacote,
#    sigstore, brace-expansion, picomatch, ip-address) and was the source of
#    every Node-level CVE in this image — none of them are app dependencies.
#    The container starts node directly, so npm is unused here. It stays in
#    the builder and test stages, which do need it.
RUN apk upgrade --no-cache libcrypto3 libssl3 \
    && rm -rf /usr/local/lib/node_modules/npm \
              /usr/local/bin/npm \
              /usr/local/bin/npx

# Copy pruned production dependencies and app source from builder stage
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/server.js ./
COPY --from=builder /app/lib ./lib
COPY --from=builder /app/public ./public

# Use non-root node user provided by alpine image
USER node

# Expose standard HTTP port
EXPOSE 3000

# Health check against internal endpoint. Shell form so $PORT is expanded
# at runtime, tracking whatever port the container actually bound to.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:${PORT:-3000}/health || exit 1

# Start the application
CMD ["node", "server.js"]
