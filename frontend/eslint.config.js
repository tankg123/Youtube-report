import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import { defineConfig, globalIgnores } from 'eslint/config'
import noUntranslated from './eslint-rules/no-untranslated.js'
import { BILINGUAL_FILES } from './i18n.files.mjs'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{js,jsx}'],
    extends: [
      js.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: globals.browser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
  },
  // Bilingual pages (Content ID, Report, shared chrome): every user-visible literal goes through
  // t() / tk() / tm() so the Vietnamese UI has no English leftovers. See eslint-rules/no-untranslated.js.
  {
    files: BILINGUAL_FILES,
    plugins: { i18n: { rules: { 'no-untranslated': noUntranslated } } },
    rules: { 'i18n/no-untranslated': 'error' },
  },
  // node:test suites (run with `npm test`): Node globals, no React plugins.
  {
    files: ['tests/**/*.mjs'],
    extends: [js.configs.recommended],
    languageOptions: {
      globals: globals.node,
    },
  },
  // Tooling modules (lint rule, file list) run in Node.
  {
    files: ['*.mjs', 'eslint-rules/**/*.js'],
    extends: [js.configs.recommended],
    languageOptions: {
      globals: globals.node,
    },
  },
])
