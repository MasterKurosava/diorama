import type { GsapApi } from './types'

export { gsapDriver } from './driver'
export { gsapPlugin } from './plugin'
export type {
  GsapApi,
  GsapLike,
  GsapPluginOptions,
  GsapTickerCallback,
  GsapTickerLike,
  PinOptions,
  PinProgress,
  ScrollTriggerLike,
  ScrollTriggerStatic,
} from './types'

declare module '@diorama/core' {
  interface Services {
    gsap: GsapApi
  }
}
