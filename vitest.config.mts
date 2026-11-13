import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 10000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // stdio-точка входу стартує сервер при імпорті — її перевіряє npm run smoke
      exclude: ['src/mcp/index.ts'],
      reporter: ['text', 'text-summary', 'html'],
      // Нижче — CI падає: нові модулі мають приходити з тестами
      thresholds: { statements: 85, branches: 75, functions: 85, lines: 85 },
    },
  },
});
