// Types of the effect descriptions and the metadata the docs site reads. Types only.
import type { Effect, QualityTier } from './types'

/** Description of one param in an effect's `.doc.ts`. */
export interface ParamDoc {
  /** One sentence. */
  readonly description: string
  /** Bounds of a slider; values outside still work. Numbers and vector components only. */
  readonly range?: readonly [number, number]
  /** Slider step. Default: 1 for integer params, else a hundredth of the range. */
  readonly step?: number
  /**
   * Unit shown next to the value: seconds for time, CSS px or em for lengths, degrees for angles,
   * 0..1 for fractions.
   */
  readonly unit?: 'px' | 's' | 'deg' | 'em' | 'deg/s' | 'px/s' | 'fraction'
}

/** An example of an effect's docs: markup and optional code. */
export interface DocExample {
  /** One line above the example. */
  readonly title: string
  /** Markup that uses the effect. */
  readonly html: string
  /** Script next to the markup, if any. */
  readonly ts?: string
}

/** A DOM event an effect dispatches on its element. */
export interface EventDoc {
  /** 'dio:marker'. Dispatched on the effect's element, bubbles. */
  readonly name: string
  /** One sentence. */
  readonly description: string
  /** TypeScript type of `detail` as text: '{ marker: Element | null; id: string | null }'. */
  readonly detail: string
}

/**
 * What the effect reads from or drives in the element's children, not a param: an attribute
 * (`{ attribute: 'data-dio-src' }`) or a child element (`{ element: 'input[type="range"]' }`).
 */
export type ChildDoc =
  | {
      /** 'data-dio-src'. */
      readonly attribute: string
      /** Not with `attribute`. */
      readonly element?: never
      /** One sentence. */
      readonly description: string
    }
  | {
      /** Selector of a child element the effect reads or drives: 'input[type="range"]'. */
      readonly element: string
      /** Not with `element`. */
      readonly attribute?: never
      /** One sentence. */
      readonly description: string
    }

/** A shadow part of the effect's own UI, styled by the site with `::part()`. */
export interface PartDoc {
  /** The `part` name: 'close'. */
  readonly name: string
  /** One sentence. */
  readonly description: string
}

/**
 * A group of the docs site's effect gallery, named by what the reader wants to animate. An
 * effect has one primary group (`category`) and may show in others (`tags`).
 */
export type EffectCategory =
  /** Text: headings, paragraphs, words and letters. */
  | 'text'
  /** Photo: one image on the page. */
  | 'photo'
  /** Galleries and viewers: sets of images, slideshows, lightboxes, books. */
  | 'gallery'
  /** Video: a playing video and what surrounds it. */
  | 'video'
  /** Scroll scenes: pinned sections and motion driven by scroll. */
  | 'scroll'
  /** 3D and product: models, turntables, panoramas. */
  | '3d'
  /** Backgrounds: decorative surfaces behind the content. */
  | 'background'
  /** Blocks and cards: cards, tiles, buttons and other blocks of a page. */
  | 'block'
  /** Sound: players, podcasts, music. */
  | 'audio'
  /** Maps and data: places, routes, numbers. */
  | 'data'
  /** Celebration and particles: confetti, sparks and other particles. */
  | 'celebration'
  /** Page transitions: from one page to the next. */
  | 'transition'

/** The written part of an effect's docs, typed against the effect so every param is described. */
// biome-ignore lint/suspicious/noExplicitAny: any effect, whatever its params
export type EffectDoc<E extends Effect<any>> =
  E extends Effect<infer P>
    ? {
        /** The gallery group it belongs to: what the reader wants to animate. */
        readonly category: EffectCategory
        /** Other groups it also shows in; never repeats `category`. */
        readonly tags?: readonly EffectCategory[]
        /** One sentence for the lede and the gallery card. */
        readonly summary: string
        /** What it looks like, two to four sentences. */
        readonly looks: string
        /** What to put it on: 'img, video', 'an empty decorative element', 'body'. */
        readonly target: string
        /** Every param, no more and no less: a missing or stray key fails typecheck. */
        readonly params: { readonly [K in keyof P]-?: ParamDoc }
        /** When frames are drawn, for people: 'only while revealing'. The policy itself is derived. */
        readonly frames: string
        /** What changes on touch devices. */
        readonly touch: string
        /** What it does under reduced motion. */
        readonly reducedMotion: string
        /** How it enters and leaves on page transitions. */
        readonly presence: string
        /** What each quality tier changes. */
        readonly quality: { readonly [T in QualityTier]?: string }
        /** GPU work and memory, for people. */
        readonly cost: { readonly gpu: string; readonly memory: string }
        /** Markup examples. */
        readonly examples: readonly DocExample[]
        /** DOM events the effect dispatches. */
        readonly events?: readonly EventDoc[]
        /** Attributes and child elements the effect reads. */
        readonly children?: readonly ChildDoc[]
        /** Shadow parts of the effect's own UI. */
        readonly parts?: readonly PartDoc[]
        /** Credits for bundled data, shown on the effect's page. */
        readonly credits?: string
      }
    : never

/** One param in `meta.json`. */
export interface ParamMeta {
  /** The param name in code. */
  readonly name: string
  /** data-dio-<kebab>. */
  readonly attribute: string
  /** Kind of value. */
  readonly type: 'number' | 'boolean' | 'color' | 'string' | 'choice' | 'vec2' | 'vec3' | 'vec4'
  /** Default value. */
  readonly default: number | boolean | string | readonly number[]
  /** Choices of a oneOf param. */
  readonly values?: readonly string[]
  /** false: a change re-runs setup (strings, choices, rebuild). */
  readonly live: boolean
  /** In the light entry: readable and tweenable before the module loads. */
  readonly preload: boolean
  /** Upper bounds by quality tier. */
  readonly caps?: { readonly [T in QualityTier]?: number }
  /** One sentence, from `.doc.ts`. */
  readonly description: string
  /** Bounds of a slider, from `.doc.ts`. */
  readonly range?: readonly [number, number]
  /** Slider step, from `.doc.ts`. */
  readonly step?: number
  /** Unit, from `.doc.ts`. */
  readonly unit?: string
}

/** One effect in `meta.json`: what the definition says plus its `.doc.ts`. */
export interface EffectMeta {
  /** The token in `data-dio`. */
  readonly name: string
  /** Module name. */
  readonly module:
    | 'media'
    | 'text'
    | 'backgrounds'
    | 'model'
    | 'globe'
    | 'audio'
    | 'particles'
    | 'blocks'
    | 'data'
  /** npm package, '@dioramajs/media'. */
  readonly package: string
  /** '@dioramajs/media/reveal', for `app.attach(el, effect())`. */
  readonly import: string
  /** start() registers it without options. */
  readonly builtIn: boolean
  /** Path of the definition in the library repo, for a Source link. */
  readonly source: string
  /** The gallery group, from `.doc.ts`. */
  readonly category: EffectCategory
  /** Other groups it also shows in, from `.doc.ts`; never repeats `category`. */
  readonly tags?: readonly EffectCategory[]
  /** One sentence for the lede and the gallery card. */
  readonly summary: string
  /** What it looks like, two to four sentences. */
  readonly looks: string
  /** What to put it on, for people. */
  readonly target: string
  /** Selector of the elements the effect accepts. */
  readonly on?: string
  /** Needs the <img> or <video> as a texture. */
  readonly media?: boolean
  /** Extra px around the box for visibility. */
  readonly bleed: number
  /** Every param in definition order. */
  readonly params: readonly ParamMeta[]
  /** Inputs the effect reads, from the probe: 'progress', 'presence', 'pointer', 'delta'… */
  readonly inputs: readonly string[]
  /** The frame policy and a note for people. 'update': the update's answer decides. */
  readonly frames: {
    readonly policy: 'input' | 'hover' | 'visible' | 'function' | 'fps' | 'update'
    readonly note: string
  }
  /** Media query the page must match. */
  readonly when?: string
  /** Behaviour under reduced motion. */
  readonly reducedMotion: { readonly mode: 'static' | 'off'; readonly note: string }
  /** How the copy enters and leaves pages. */
  readonly presence: { readonly mode: 'fade' | 'custom'; readonly note: string }
  /** Behaviour on touch devices. */
  readonly touch: string
  /** The lowest tier and what each tier changes. */
  readonly quality: {
    readonly min: QualityTier
    readonly notes: { readonly [T in QualityTier]?: string }
  }
  /**
   * chunk: bytes min+gzip of the effect's lazy chunk, three external, data included;
   * data: the bundled data part of it, if any.
   */
  readonly cost: {
    readonly gpu: string
    readonly memory: string
    readonly chunk: number
    readonly data?: number
  }
  /** Examples from `.doc.ts`. */
  readonly examples: readonly DocExample[]
  /** DOM events the effect dispatches, from `.doc.ts`. */
  readonly events?: readonly EventDoc[]
  /** Attributes and child elements the effect reads, from `.doc.ts`. */
  readonly children?: readonly ChildDoc[]
  /** Shadow parts of the effect's own UI, from `.doc.ts`. */
  readonly parts?: readonly PartDoc[]
  /** Credits for bundled data, from `.doc.ts`. */
  readonly credits?: string
}
