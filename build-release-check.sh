# Pre-build-and-run checklist for production
# Usage:
#   bash build-release.sh   # build
#   npm start               # starts with the compiled code

echo "🔨 Building lms-backend for production..."
npm run build || exit 1

echo "✅ Build complete"

# If you also have Docker, the resulting dist/ + new Dockerfile will work
# with any runtime-provided DATABASE_URL.  If you instead rely on Railway's
# build phase, stop here — Railway already calls `npm run build`.
