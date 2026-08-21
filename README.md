# Binance P2P Trading Assistant 2026

Dashboard React + Vite + Express para USDT/VES con datos P2P, matriz bancaria, proyecciones, histórico, backtest y alertas.

## Estructura

- `index.html` -> entrada Vite en la raíz.
- `src/` -> aplicación React.
- `server.ts` -> servidor Express + Vite/SPA.
- `server/` -> Binance P2P, store, proyecciones, rutas y almacenamiento.

## Desarrollo

```bash
npm install
npm run dev
```

## Producción

```bash
npm install
npm run build
npm start
```

El servidor escucha `process.env.PORT` y usa `3000` como valor local por defecto.

## Render

Build command:

```text
npm install && npm run build
```

Start command:

```text
npm start
```

No pongas `src` como Root Directory. El repositorio debe tener `index.html`, `package.json` y `server.ts` en la raíz.
