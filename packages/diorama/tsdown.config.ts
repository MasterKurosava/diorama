import { resolve } from 'node:path'
import { defineConfig } from 'tsdown'

export default defineConfig([
  {
    entry: { index: 'src/index.ts', generated: 'src/generated.ts' },
    format: 'esm',
    platform: 'neutral',
    target: 'es2022',
    // The slot stays an import: a build plugin points it at the site's effects folder.
    external: ['diorama/generated'],
    dts: { sourcemap: true },
    sourcemap: true,
    clean: true,
  },
  {
    entry: {
      vite: 'src/vite.ts',
      astro: 'src/astro.ts',
      nuxt: 'src/nuxt.ts',
      next: 'src/next.ts',
      cli: 'src/cli.ts',
    },
    format: 'esm',
    platform: 'node',
    // .js like the other packages: package.json points at dist/*.js
    fixedExtension: false,
    target: 'es2022',
    dts: { sourcemap: true },
    sourcemap: true,
    clean: false,
  },
  {
    // The CDN build: everything bundled, three and the runtime in lazy chunks next to it.
    entry: { auto: 'src/auto.ts' },
    outDir: 'dist/cdn',
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    noExternal: [/.*/],
    alias: { 'diorama/generated': resolve(import.meta.dirname, 'src/generated.ts') },
    minify: true,
    dts: false,
    clean: false,
  },
])
