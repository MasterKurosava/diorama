import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts'],
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  // The dts generator always references a .d.ts.map, so emit one
  dts: { sourcemap: true },
  sourcemap: true,
  clean: true,
})
