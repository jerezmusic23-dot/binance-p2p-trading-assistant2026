import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Characterization tests touch module-level singletons (StorageEngine,
    // CentralMarketStore) and process.cwd(). Isolate every file in its own
    // process so no state leaks between suites.
    pool: 'forks',
    poolOptions: {
      forks: { singleFork: false },
    },
    restoreMocks: true,
    /*
     * The default 5 000 ms is too tight for this suite on a modest container.
     * BacktestEngine.run over a 300-record series walks every anchor and lands
     * at ~4 990 ms here - under the limit on a good run and over it on a bad
     * one, so the same commit passed or failed depending on the machine. The
     * tests were never wrong; the budget was. Raised to a value no healthy test
     * approaches, so a timeout again means something is actually stuck.
     */
    testTimeout: 30_000,
  },
});
