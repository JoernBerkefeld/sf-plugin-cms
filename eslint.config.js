import js from '@eslint/js';
import prettier from 'eslint-plugin-prettier/recommended';
import jsdoc from 'eslint-plugin-jsdoc';
import unicorn from 'eslint-plugin-unicorn';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['node_modules/**', 'lib/**', 'coverage/**', 'logs/**', 'src/generated/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  jsdoc.configs['flat/recommended'],
  unicorn.configs.recommended,
  prettier,
  {
    languageOptions: { globals: globals.nodeBuiltin },
    rules: {
      // Exported functions carry JSDoc; small private helpers do not need it.
      'jsdoc/require-jsdoc': 'off',
      // Salesforce answers use null (e.g. nextPageUrl, apiName), so the plugin does too.
      'unicorn/no-null': 'off',
      'unicorn/no-asterisk-prefix-in-documentation-comments': 'off',
    },
  },
);
