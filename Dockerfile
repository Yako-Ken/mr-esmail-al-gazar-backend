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

# إعداد رابط قاعدة البيانات عشان يبني الجداول جواها
ENV DATABASE_URL="file:./prisma/dev.db"

# توليد كود العميل وبناء الجداول في قاعدة البيانات
RUN npx prisma generate
RUN npx prisma db push

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

# Copy built files from the builder stage
COPY --from=builder /app/dist ./dist
# السطر ده هينسخ فولدر prisma بالكامل بما فيه ملف الداتابيز اللي اتكريت (dev.db)
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma

# Set environment variables
ENV NODE_ENV=production
ENV PORT=5000
ENV DATABASE_URL="file:./prisma/dev.db"

# Expose the port
EXPOSE 5000

# Start the application
CMD ["node", "dist/src/server.js"]