import { defineConfig } from 'eslint/config'
import tseslint from '@electron-toolkit/eslint-config-ts'
import eslintConfigPrettier from '@electron-toolkit/eslint-config-prettier'

export default defineConfig(
  { ignores: ['**/node_modules', '**/dist', '**/out', '**/electron-dist', '**/release'] },
  tseslint.configs.recommended,
  eslintConfigPrettier,
  {
    files: ['**/*.{ts,tsx}'],
    rules: {
      // React component inference is intentional in the cc-haha-style
      // renderer; the TypeScript compiler remains the source of truth.
      '@typescript-eslint/explicit-function-return-type': 'off'
    }
  }
)
