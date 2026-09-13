import js from '@eslint/js';
import prettierRecommended from 'eslint-plugin-prettier/recommended';
import unicorn from 'eslint-plugin-unicorn';
import globals from 'globals';
import jsdoc from 'eslint-plugin-jsdoc';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['lib/**', 'coverage/**', 'node_modules/**', 'resources/**', 'src/generated/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettierRecommended,
  jsdoc.configs['flat/recommended'],
  unicorn.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2025,
      globals: globals.node,
      sourceType: 'module',
    },
    rules: {
      'jsdoc/require-jsdoc': 'off',
      'unicorn/filename-case': 'off',
      'unicorn/no-null': 'off',
      'unicorn/prevent-abbreviations': 'off',
      'unicorn/prefer-top-level-await': 'off',
    },
  },
  {
    files: ['test/**/*.ts'],
    languageOptions: {
      globals: globals.mocha,
    },
  },
);
