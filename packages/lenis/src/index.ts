import type { LenisApi } from './types'

export { lenisPlugin } from './plugin'
export { lenisSource } from './source'
export type { LenisApi, LenisLike, LenisPluginOptions } from './types'

declare module '@diorama/core' {
  interface Services {
    lenis: LenisApi
  }
}
