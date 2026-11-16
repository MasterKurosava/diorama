// diorama/nuxt, used as `modules: ['diorama/nuxt']` in nuxt.config. Nuxt builds with Vite, so
// this adds the Vite plugin with the folder under srcDir (app/effects in Nuxt 4). Call `start()`
// in a client plugin (plugins/diorama.client.ts).
import { join } from 'node:path'
import { type DioramaPluginOptions, diorama } from './vite'

export interface NuxtLike {
  readonly options: { readonly srcDir: string }
  hook(name: 'vite:extendConfig', callback: (config: { plugins?: unknown[] }) => void): unknown
}

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
