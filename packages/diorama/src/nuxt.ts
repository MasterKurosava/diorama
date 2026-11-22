// diorama/nuxt, used as `modules: ['@dioramajs/diorama/nuxt']` in nuxt.config. Nuxt builds with Vite, so
// this adds the Vite plugin with the folder under srcDir (app/effects in Nuxt 4). Call `start()`
// in a client plugin (plugins/diorama.client.ts).
import { join } from 'node:path'
import { type DioramaPluginOptions, diorama } from './vite'

/** The part of Nuxt the module uses. */
export interface NuxtLike {
  /** Nuxt options; `srcDir` holds the effects folder. */
  readonly options: { readonly srcDir: string }
  /** Registers the hook that adds the Vite plugin. */
  hook(name: 'vite:extendConfig', callback: (config: { plugins?: unknown[] }) => void): unknown
}

/** The Nuxt module: the Vite plugin for the effects folder. */
export default function dioramaModule(options: DioramaPluginOptions, nuxt: NuxtLike): void {
  const src = nuxt.options.srcDir
  const plugin = diorama({
    dir: options.dir ?? join(src, 'effects'),
    types: options.types ?? join(src, 'diorama.gen.d.ts'),
  })
  nuxt.hook('vite:extendConfig', (config) => {
    config.plugins ??= []
    config.plugins.push(plugin)
  })
}
