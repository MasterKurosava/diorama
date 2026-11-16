// diorama/astro, used as `integrations: [diorama()]` in astro.config. Astro builds with Vite, so
// this adds the Vite plugin. Call `start()` in a <script> of the layout.
import { type DioramaPluginOptions, diorama as vite } from './vite'

export interface AstroIntegrationLike {
  readonly name: string
  readonly hooks: {
    readonly 'astro:config:setup': (params: {
      updateConfig(config: { vite: { plugins: unknown[] } }): unknown
    }) => void
  }
}

export function diorama(options: DioramaPluginOptions = {}): AstroIntegrationLike {
  return {
    name: 'diorama',
    hooks: {
      'astro:config:setup': ({ updateConfig }) => {
        updateConfig({ vite: { plugins: [vite(options)] } })
      },
    },
  }
}

export default diorama
