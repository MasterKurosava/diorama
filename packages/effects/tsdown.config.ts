import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'runtime/index': 'src/runtime/index.ts',
    effect: 'src/effect.ts',
    kit: 'src/kit.ts',
    testing: 'src/testing/index.ts',
  },
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  // The declaration generator always references a .d.ts.map, so emit one
  dts: { sourcemap: true },
  sourcemap: true,
  // A relative glob: `true` becomes an absolute one, which matches nothing under "folder (2)"
  clean: ['dist'],
  outputOptions: {
    // A site bundler keeps a dist file whole: if the light modules shared a file with the
    // definition code, every site's main chunk would hold it.
    codeSplitting: {
      includeDependenciesRecursively: false,
      groups: [{ name: 'define', test: /[\\/]src[\\/](define|errors|params)\.ts$/ }],
    },
  },
})
