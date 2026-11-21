import { resolve } from 'node:path'
import { defineConfig } from 'tsdown'

const MODULES =
  'core effects media model text backgrounds globe audio particles blocks data quality transitions assets gsap lenis render glsl'.split(
    ' ',
  )

export default defineConfig([
  {
    entry: {
      index: 'src/index.ts',
      generated: 'src/generated.ts',
      // The page side of the Astro integration. It shares `ready` with index through a chunk.
      'astro-client': 'src/astro-client.ts',
      // Thin re-exports of the modules, for sites that installed only diorama.
      ...Object.fromEntries(MODULES.map((name) => [name, `src/${name}.ts`])),
      // What copies made by `dioramajs add` import besides the modules.
      kit: 'src/kit.ts',
      'audio-graph': 'src/audio-graph.ts',
      'model-rig': 'src/model-rig.ts',
    },
    format: 'esm',
    platform: 'neutral',
    target: 'es2022',
    // The slot stays an import: a build plugin points it at the site's effects folder.
    external: ['dioramajs/generated'],
    dts: { sourcemap: true },
    sourcemap: true,
    // A relative glob: `true` becomes an absolute one, which matches nothing under "folder (2)".
    // It also clears dist/cdn and dist/esm, so no chunk of an earlier build is left there.
    clean: ['dist'],
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
    alias: { 'dioramajs/generated': resolve(import.meta.dirname, 'src/generated.ts') },
    minify: true,
    dts: false,
    // Chunk names change with every build: a chunk of an earlier build must not ship
    clean: ['dist/cdn'],
  },
  {
    // The same entry with three left to the page's import map, so effect files written for the
    // page import `three/tsl` and `three/webgpu` from the one copy the runtime uses.
    entry: { index: 'src/auto.ts' },
    outDir: 'dist/esm',
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    noExternal: [/^(?!three(\/|$))/],
    external: [/^three(\/|$)/],
    alias: { 'dioramajs/generated': resolve(import.meta.dirname, 'src/generated.ts') },
    minify: true,
    dts: false,
    clean: ['dist/esm'],
  },
])
