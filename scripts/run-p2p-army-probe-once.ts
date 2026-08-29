/**
 * LANZADOR DE UN SOLO DISPARO PARA EL PROBE (TEMPORAL)
 * ===================================================
 *
 * Entrada del bundle `dist/p2p-probe.cjs`, que el arranque de Railway lanza EN
 * PARALELO al servidor. Se ejecuta una vez, imprime su bloque y termina.
 *
 * ═══ POR QUÉ EN PARALELO Y NO ANTES ═══
 *
 * Si el probe corriera antes del servidor, cualquier lentitud de la API
 * retrasaría el `listen` y Railway podría dar el despliegue por caído. Yendo en
 * paralelo, el servidor arranca igual de rápido que siempre y el informe
 * aparece en los logs cuando esté listo. El probe amortigua su salida y la
 * imprime de una vez, así que el bloque sale entero y no entrelazado con el
 * polling de Binance.
 *
 * ═══ TOPE DURO ═══
 *
 * Pase lo que pase, este proceso muere a los HARD_DEADLINE_MS. Un probe colgado
 * no puede quedarse consumiendo un proceso en producción indefinidamente.
 *
 * ═══ TEMPORAL, Y CÓMO SE QUITA ═══
 *
 * Esto es diagnóstico, no una función del bot. Para retirarlo:
 *   1. En package.json, `start` vuelve a ser:  node dist/server.cjs
 *   2. En package.json, quitar `build:probe` de `build`
 *   3. Borrar scripts/ y server/external/
 * No hay ninguna otra dependencia: nada del bot importa estos ficheros.
 */

const HARD_DEADLINE_MS = 90_000;

const guard = setTimeout(() => {
  console.log('========== P2P.ARMY REAL PROBE ==========');
  console.log(`ABORTED: el probe superó el tope de ${HARD_DEADLINE_MS / 1000}s y se detuvo.`);
  console.log('El servidor no se ve afectado: corre en su propio proceso.');
  console.log('========== END P2P.ARMY REAL PROBE ==========');
  process.exit(0);
}, HARD_DEADLINE_MS);

// El propio probe imprime el bloque y controla sus errores.
import('./p2p-army-probe.js')
  .catch((err: unknown) => {
    console.log('========== P2P.ARMY REAL PROBE ==========');
    console.log(`ABORTED: no se pudo cargar el probe: ${err instanceof Error ? err.message : String(err)}`);
    console.log('========== END P2P.ARMY REAL PROBE ==========');
  })
  .finally(() => {
    clearTimeout(guard);
  });
