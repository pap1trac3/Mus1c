# ==========================================
# STAGE 1: Build & Install Dependencies
# ==========================================
FROM node:20-alpine AS builder

WORKDIR /app

# Copy dependency manifests
COPY package*.json ./

# Install production-only dependencies (no jest/supertest in the runtime image)
RUN npm ci --omit=dev

# Copy application source code
COPY server.js ./
COPY lib ./lib

# ==========================================
# STAGE 2: Production Runtime
# ==========================================
FROM node:20-alpine AS runner

WORKDIR /app

# Set production environment
ENV NODE_ENV=production
ENV PORT=3000

# Copy pruned production dependencies and app source from builder stage
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/server.js ./
COPY --from=builder /app/lib ./lib

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
