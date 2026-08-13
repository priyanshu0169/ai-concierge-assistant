import js from '@eslint/js';
import globals from 'globals';

/**
 * ShopSage lint configuration.
 *
 * The rules below are the machine-enforced version of the project coding
 * standard: small files, small functions, shallow nesting, single
 * responsibility. If a rule fires, the fix is to decompose the code - not to
 * raise the threshold.
 */
export default [
  {
    ignores: ['**/node_modules/**', '**/dist/**', '**/coverage/**', '**/*.d.ts'],
  },
  js.configs.recommended,
  {
    languageOptions: {
      // `latest` rather than a fixed year: the codebase uses import attributes
      // (`with { type: 'json' }`), which older parser targets reject.
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.node },
    },
    linterOptions: {
      reportUnusedDisableDirectives: 'error',
    },
    rules: {
      // Structural limits - the coding standard, enforced.
      complexity: ['error', 10],
      'max-depth': ['error', 3],
      'max-lines': ['error', { max: 250, skipBlankLines: true, skipComments: true }],
      'max-lines-per-function': ['error', { max: 60, skipBlankLines: true, skipComments: true }],
      'max-params': ['error', 3],
      'max-nested-callbacks': ['error', 3],

      // Correctness.
      eqeqeq: ['error', 'always'],
      'no-console': 'error',
      'no-param-reassign': ['error', { props: true }],
      'no-throw-literal': 'error',
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-var': 'error',
      'prefer-const': 'error',
      'require-atomic-updates': 'error',

      // Async hygiene.
      'no-return-await': 'error',
      'require-await': 'error',
    },
  },
  {
    /**
     * Express middleware sits on two framework contracts we do not control:
     * an error handler is only recognised if it declares four parameters, and
     * per-request state is published by decorating `req`. Both exceptions are
     * confined to this directory so the stricter rules keep applying to the
     * domain and delivery code that has a choice.
     */
    files: ['packages/*/src/http/middleware/**/*.js'],
    rules: {
      'max-params': ['error', 4],
      'no-param-reassign': ['error', { props: false }],
    },
  },
  {
    /**
     * The widget's element modules exist to mutate DOM nodes handed to them.
     *
     * `no-param-reassign` with `props: true` is aimed at accidental mutation of plain data
     * objects, and painting text into an element that was passed in is neither accidental nor
     * data. Scoped to this one directory - the markdown renderer and the API client keep the
     * stricter rule, because they have a choice.
     */
    files: ['packages/widget/src/element/**/*.js'],
    rules: {
      'no-param-reassign': ['error', { props: false }],
    },
  },
  {
    /**
     * The widget runs in a browser, not in Node.
     *
     * Scoped to this package rather than added globally: `document` and `window` being valid
     * names everywhere would mean a stray browser reference in backend code lints clean. Its
     * tests keep Node globals as well, since they run under `node:test`.
     */
    files: ['packages/widget/**/*.js'],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
    },
  },
  {
    // Tests describe scenarios; they are allowed to be longer and more nested.
    files: ['**/test/**/*.js'],
    rules: {
      'max-lines': 'off',
      'max-lines-per-function': 'off',
      'max-nested-callbacks': 'off',
    },
  },
];
