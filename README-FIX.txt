BINANCE P2P TRADING ASSISTANT - FIX HANDOFF

Replace/merge the contents of your project with these files.

Important:
- Keep your existing server.ts and server/ backend files.
- The fixed files assume the React files live directly under src/.
- package.json is valid JSON and has Vite declared only once.
- vite.config.ts enables React + Tailwind v4.

After merging:
  npm install
  npm run build

Render build command can remain:
  vite build && esbuild server.ts --bundle --platform=node --format=cjs --packages=external --sourcemap --outfile=dist/server.cjs
