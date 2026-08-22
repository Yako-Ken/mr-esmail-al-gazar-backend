# Force a clean production build of the TypeScript backend into dist/.
# Run this on the machine that owns the real code (Windows / CI / Railway build).
# The old dist/ folder was ~3 months out of sync with src/; this rebuilds it.
#
# After this, `npm start` (or `node dist/src/server.js`) runs the same code as the tests.
# On Railway you do NOT need to run this manually — the platform runs `npm run build`
# as part of the build phase and then `npm start`.

echo "🔨 Building lms-backend for production..."
npm run build

echo "✅ TypeScript compiled to dist/"
ls -la dist/src/server.js dist/app.js
