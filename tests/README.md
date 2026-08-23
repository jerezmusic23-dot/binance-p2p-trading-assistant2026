# Characterization tests

These suites exist to **freeze the current behaviour of the system** before it
is changed. They are the safety net required by CLAUDE.md REGLA 4.

## The `BUG:` convention

A test whose name starts with `BUG:` asserts behaviour that the audit
identified as **defective**. It documents what the code does *today*, with a
comment citing the finding.

**These tests are expected to fail when the bug is fixed.** That is the point:
the failure is the signal that a fabricated value, a silent data loss or a
mislabelled field has actually been removed. When you fix one:

1. confirm the new behaviour is what the project rules require;
2. rewrite the test to assert the corrected behaviour;
3. drop the `BUG:` prefix and the audit citation.

Never delete a `BUG:` test to make the suite green.

A test **without** the prefix pins behaviour that should be preserved. If one
of those breaks, treat it as a regression until proven otherwise.

## Isolation

`StorageEngine` and `CentralMarketStore` are module-level singletons that
resolve `data/` from `process.cwd()` at class-definition time. Suites that
touch them:

- `chdir` into a fresh `mkdtemp` directory in `beforeEach`;
- call `vi.resetModules()` before `await import(...)` to get a clean instance;
- restore the original cwd and remove the temp dir in `afterEach`.

`vitest.config.ts` runs each file in its own fork for the same reason. No test
touches the repository's own `data/` directory, and none performs real network
I/O — `fetch` is always stubbed.

## Running

```bash
npm test          # single run
npm run test:watch
npm run lint      # tsc --noEmit, now covers tests/ too
```
