import { defineConfig } from 'tsdown'

export default defineConfig({
  // The cover entry loads its looks, and three with them, in chunks of their own.
  entry: { index: 'src/index.ts', 'cover/index': 'src/cover/index.ts' },
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  // The dts generator always references a .d.ts.map, so emit one
  dts: { sourcemap: true },
  sourcemap: true,
  // A relative glob: `true` becomes an absolute one, which matches nothing under "folder (2)"
  clean: ['dist'],
})
