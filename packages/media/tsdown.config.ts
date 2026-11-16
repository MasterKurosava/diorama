import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts', 'src/image.ts', 'src/ripple.ts', 'src/bend.ts'],
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  // The declaration generator always references a .d.ts.map, so emit one
  dts: { sourcemap: true },
  sourcemap: true,
  clean: true,
})
