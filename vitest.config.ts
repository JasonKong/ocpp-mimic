import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const src = (pkg: string) =>
  fileURLToPath(new URL(`./packages/${pkg}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    // Tests run against package sources, so no build is needed before `pnpm test`.
    alias: {
      '@ocpp-mimic/core': src('core'),
      '@ocpp-mimic/engine': src('engine'),
    },
  },
  test: {
    projects: [
      { extends: true, test: { name: 'packages', include: ['packages/*/src/**/*.test.ts'] } },
      // The Web UI compiles its .vue components with the Vue plugin.
      'apps/web/vitest.config.ts',
    ],
  },
});
