import eslint from '@eslint/js'
import globals from 'globals'

export default [
  { ignores: ['node_modules/**', 'coverage/**', 'site/data/**'] },
  eslint.configs.recommended,
  {
    files: ['**/*.{js,mjs}'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module', globals: globals.node },
    rules: {
      'no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
    },
  },
  { files: ['site/lib/**/*.js'], languageOptions: { globals: { ...globals.browser, ...globals.node } } },
]
