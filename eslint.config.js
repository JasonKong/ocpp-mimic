import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import { defineConfig, globalIgnores } from 'eslint/config';
import vue from 'eslint-plugin-vue';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig([
  globalIgnores(['**/dist/', '**/coverage/', '**/*.tsbuildinfo', 'release/']),
  js.configs.recommended,
  tseslint.configs.recommended,
  vue.configs['flat/recommended'],
  {
    rules: {
      // `const { dropped: _, ...rest } = value` is how optional properties are removed.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { ignoreRestSiblings: true, argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    files: ['**/*.vue'],
    languageOptions: { parserOptions: { parser: tseslint.parser } },
  },
  {
    files: [
      'packages/engine/**',
      'packages/cli/**',
      'tools/**',
      '*.{js,ts}',
      'apps/web/vite.config.ts',
      'apps/web/vitest.config.ts',
    ],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['apps/web/src/**'],
    languageOptions: { globals: globals.browser },
  },
  prettier,
]);
