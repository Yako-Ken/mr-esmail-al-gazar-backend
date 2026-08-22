# Stage 1: Build stage
FROM node:18-alpine AS builder

# تسطيب مكتبات النظام الضرورية لـ Prisma
RUN apk add --no-cache openssl openssl-dev

WORKDIR /app

# Copy package files
COPY package*.json ./
COPY prisma ./prisma/

# Install ALL dependencies
RUN npm install

# Copy the rest of the application code
COPY . .

# Generate the Prisma client only. Database migrations and seeding must happen
# against the runtime database, never against a disposable image-layer SQLite DB.
RUN npx prisma generate

# Build the TypeScript project
RUN npm run build

# Stage 2: Production stage
FROM node:18-alpine

# تسطيب مكتبات النظام الضرورية لـ Prisma في النسخة النهائية
RUN apk add --no-cache openssl openssl-dev

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install only production dependencies
RUN npm install --omit=dev

# Copy built files and migration/schema metadata from the builder stage.
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma

# ⚠️ DO NOT set ENV DATABASE_URL here!
# The container MUST receive its database connection string at runtime from
# the platform (Railway variables / docker -e / docker-compose environment).
# Hard-coding a file-based URL here makes the container look for ./prisma/dev.db
# inside the image — wiping it on every redeploy.
#
# The server is expected to see something like:
#   railway.app   : postgresql://postgres:<pwd>@postgres.railway.internal:5432/postgres
#   local docker  : postgresql://postgres:postgres@host.docker.internal:5432/edutech
#
# If you intentionally want SQLite for on-prem use, do:
#   docker run -e DATABASE_URL="file:/data/edutech.db" -v edutech-data:/data ...
#
# ENV NODE_ENV=production is fine; PORT is also safe to leave to the platform.
ENV NODE_ENV=production

# Expose the port (documentation only; Railway injects $PORT)
EXPOSE 5000

# Start the application using npm start to trigger schema sync
CMD ["npm", "start"]
