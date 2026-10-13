import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

function asWarnings(...configs) {
  return Object.fromEntries(
    configs.flat().flatMap((config) =>
      Object.entries(config.rules ?? {}).map(([rule, setting]) => {
        const severity = Array.isArray(setting) ? setting[0] : setting;
        if (severity === 0 || severity === 'off') return [rule, 'off'];
        return [rule, Array.isArray(setting) ? ['warn', ...setting.slice(1)] : 'warn'];
      }),
    ),
  );
}

export default defineConfig([
  globalIgnores([
    'dist/**',
    '.wrangler/**',
    '.next/**',
    '.open-next/**',
    '.tanstack/**',
    'src/routeTree.gen.ts',
    'drizzle/**',
    'public/**',
  ]),
  {
    linterOptions: {
      reportUnusedDisableDirectives: 'warn',
    },
  },
  {
    files: ['**/*.{js,cjs,mjs}'],
    extends: [js.configs.recommended],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    files: ['**/*.{ts,tsx,mts,cts}'],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    plugins: {
      'react-hooks': reactHooks,
    },
    rules: {
      ...asWarnings(js.configs.recommended, tseslint.configs.recommended),
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
        },
      ],
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  {
    files: ['src/**/*.{ts,tsx,mts,cts}'],
    ignores: ['src/**/*.test.ts', 'src/server/testing/**'],
    extends: [tseslint.configs.recommendedTypeCheckedOnly],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      ...asWarnings(tseslint.configs.recommendedTypeCheckedOnly),
      '@typescript-eslint/no-floating-promises': 'warn',
      '@typescript-eslint/only-throw-error': 'off',
    },
  },
]);
