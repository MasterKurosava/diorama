import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/gradient.ts',
    'src/dots.ts',
    'src/waves.ts',
    'src/stars.ts',
    'src/blobs.ts',
    'src/clouds.ts',
    'src/grid.ts',
  ],
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  // The declaration generator always references a .d.ts.map, so emit one
  dts: { sourcemap: true },
  sourcemap: true,
  // A relative glob: `true` becomes an absolute one, which matches nothing under "folder (2)"
  clean: ['dist'],
})
