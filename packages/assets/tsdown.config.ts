import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: { index: 'src/index.ts', 'three/index': 'src/three/index.ts' },
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  // The declaration generator always references a .d.ts.map, so emit one
  dts: { sourcemap: true },
  sourcemap: true,
  // A relative glob: `true` becomes an absolute one, which matches nothing under "folder (2)"
  clean: ['dist'],
})
