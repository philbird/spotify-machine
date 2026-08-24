import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Backend tests run in node; the Dashboard test opts into jsdom via a
    // `@vitest-environment jsdom` docblock.
    include: ['tests/**/*.test.ts', 'web/src/**/*.test.tsx'],
  },
});
