import typescript from '@rollup/plugin-typescript'
import { defineConfig } from 'vitest/config'
import { puyaTsTransformer } from '@algorandfoundation/algorand-typescript-testing/vitest-transformer'

export default defineConfig({
  esbuild: {},
  test: {
    include: ['**/*.spec.ts'],
    setupFiles: 'vitest.setup.ts',
  },
  plugins: [
    typescript({
      tsconfig: './tsconfig.test.json',
      transformers: {
        before: [puyaTsTransformer],
      },
    }),
  ],
})
