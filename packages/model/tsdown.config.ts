import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/model.ts',
    'src/device.ts',
    'src/book.ts',
    'src/box.ts',
    'src/explode.ts',
    'src/hotspots.ts',
    'src/coin.ts',
    'src/vinyl.ts',
    'src/label.ts',
    // Shared with copies made by `dioramajs add`, so explode and hotspots find the model's rig.
    'src/rig.ts',
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
