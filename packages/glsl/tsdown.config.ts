import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    entries: 'src/entries.ts',
    convert: 'src/convert/index.ts',
    vite: 'src/vite.ts',
    loader: 'src/loader.ts',
    cli: 'src/cli.ts',
  },
  format: 'esm',
  platform: 'node',
  // .js like the other packages: package.json and bin point at dist/*.js
  fixedExtension: false,
  target: 'es2022',
  // The declaration generator always references a .d.ts.map, so emit one
  dts: { sourcemap: true },
  sourcemap: true,
  // A relative glob: `true` becomes an absolute one, which matches nothing under "folder (2)"
  clean: ['dist'],
})
