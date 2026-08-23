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
  },
});
