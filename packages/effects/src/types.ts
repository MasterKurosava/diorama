import type {
  AppScope,
  Cancel,
  Cleanup,
  Empty,
  FrameTime,
  Off,
  Plugin,
  PluginEntry,
  ReadonlySignal,
  Services,
} from '@diorama/core'
import type { Box, RenderApi, RenderOptions } from '@diorama/render'
import type {
  Group,
  Mesh,
  MeshBasicNodeMaterial,
  Node,
  Object3D,
  Texture,
  UniformNode,
} from 'three/webgpu'

// Params

export interface ColorParam {
  readonly '~kind': 'color'
  readonly value: string
}
export interface ChoiceParam<T extends string = string> {
  readonly '~kind': 'choice'
  readonly values: readonly [T, ...T[]]
}
/** A plain string param whose default looks like a colour, e.g. `text('#cafe')`. */
export interface TextParam {
  readonly '~kind': 'string'
  readonly value: string
}

export type ParamDefault =
  | number
  | boolean
  | string
  | readonly [number, number]
  | readonly [number, number, number]
  | readonly [number, number, number, number]
  | ColorParam
  | ChoiceParam
  | TextParam
export type ParamSpec = { readonly [name: string]: ParamDefault }

export type ParamValue<D> = D extends number
  ? number
  : D extends boolean
    ? boolean
    : D extends ColorParam | TextParam
      ? string
      : D extends ChoiceParam<infer T>
        ? T
        : D extends string
          ? string
          : D extends readonly [number, number, number, number]
            ? readonly [number, number, number, number]
            : D extends readonly [number, number, number]
              ? readonly [number, number, number]
              : D extends readonly [number, number]
                ? readonly [number, number]
                : never
/** Widens literal defaults so `Effect<{ strength: number }>` accepts `{ strength: 1 }`. */
export type WidenSpec<P extends ParamSpec> = {
  -readonly [K in keyof P]: P[K] extends number
    ? number
    : P[K] extends boolean
      ? boolean
      : P[K] extends string | TextParam
        ? string
        : P[K] extends readonly [number, number, number, number]
          ? readonly [number, number, number, number]
          : P[K] extends readonly [number, number, number]
            ? readonly [number, number, number]
            : P[K] extends readonly [number, number]
              ? readonly [number, number]
              : P[K]
}
export type ParamsOf<P extends ParamSpec> = { -readonly [K in keyof P]: ParamValue<P[K]> }
export type AnyParamValue = number | boolean | string | readonly number[]

/** Live view of a tuple param. Each component can be tweened. */
export interface ParamVector {
  x: number
  y: number
  /** vec3 and vec4 only. */
  z?: number
  w?: number
  readonly length: 2 | 3 | 4
  [index: number]: number
  [Symbol.iterator](): Iterator<number>
}
/**
 * Writable params of handles and instances. Tuples read as live vectors you can tween by
 * component. Write a whole tuple with `set({ offset: [1, 2] })`.
 */
export type LiveParams<P extends ParamSpec> = {
  -readonly [K in keyof P]: P[K] extends readonly number[] ? ParamVector : ParamValue<P[K]>
}

// Inputs

/** Built-in inputs as TSL uniforms. Each one is created on first access and only then updated. */
export interface InputUniforms {
  /** Pointer in element UV, y up like `uv()`. 0..1 inside the box, not clamped outside. */
  readonly pointer: UniformNode<'vec2'>
  /** Pointer in world px on the z = 0 plane. Viewport centre is 0,0, y up. */
  readonly pointerWorld: UniformNode<'vec2'>
  /** Damped 0..1 while the pointer is over the box. 0 under reduced motion. */
  readonly hover: UniformNode<'float'>
  /** Scroll velocity in -1..1 (3000 px/s is 1), positive scrolling down. 0 under reduced motion. */
  readonly velocity: UniformNode<'float'>
  /** 0 as the top enters at the bottom of the viewport, 1 as the bottom leaves at the top. */
  readonly progress: UniformNode<'float'>
  /** 0 when the top reaches the viewport top, 1 when the bottom reaches the viewport bottom. */
  readonly pin: UniformNode<'float'>
  /** Box size in CSS px. */
  readonly size: UniformNode<'vec2'>
  /** Seconds that advance only while visible. Frozen under reduced motion. */
  readonly time: UniformNode<'float'>
  /**
   * Seconds that run while hovered or while `hover` decays, frozen at rest and under reduced
   * motion. Reading it implies `animate: 'hover'`.
   */
  readonly hoverTime: UniformNode<'float'>
  /** 1 normally, 0 under prefers-reduced-motion. Handy as a multiplier. */
  readonly motion: UniformNode<'float'>
  /**
   * CSS opacity of the element and its ancestors, times the copy's opacity and presence while
   * taken. The surface applies it and `ctx.mask()` includes it.
   */
  readonly opacity: UniformNode<'float'>
  /** 1 at rest, 0..1 while the copy enters or leaves a page. */
  readonly presence: UniformNode<'float'>
}

/** The same inputs as numbers. One object per layer, updated in place in `layout`. */
export interface EffectInput {
  /** Viewport box in CSS px. */
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  /** On screen this frame (box plus bleed, or posed). */
  readonly visible: boolean
  readonly pointer: { readonly x: number; readonly y: number }
  readonly pointerWorld: { readonly x: number; readonly y: number }
  /** Pointer is over the box right now, without damping or reduced motion. */
  readonly over: boolean
  readonly hover: number
  readonly velocity: number
  readonly progress: number
  readonly pin: number
  readonly time: number
  readonly hoverTime: number
  /** Seconds since the previous frame. */
  readonly delta: number
  readonly reducedMotion: boolean
  readonly opacity: number
  readonly presence: number
}

export type ParamUniform<D> = D extends number | boolean
  ? UniformNode<'float'>
  : D extends ColorParam
    ? UniformNode<'color'>
    : D extends readonly [number, number, number, number]
      ? UniformNode<'vec4'>
      : D extends readonly [number, number, number]
        ? UniformNode<'vec3'>
        : D extends readonly [number, number]
          ? UniformNode<'vec2'>
          : never
export type Uniforms<P extends ParamSpec> = InputUniforms & {
  readonly [K in keyof P as ParamUniform<P[K]> extends never ? never : K]: ParamUniform<P[K]>
}

/**
 * Names a param cannot take: input uniforms (they share `ctx.u`) and reserved attributes.
 * `EffectInput` keys are fine because inputs live on `ctx.input`.
 */
export type ReservedParam = keyof InputUniforms | ReservedAttr

/** `data-dio-*` names used by the framework itself. */
export type ReservedAttr =
  | 'key'
  | 'state'
  | 'track'
  | 'load'
  | 'preload'
  | 'progress'
  | 'vt'
  | 'transition'

/** Definition options, never valid as param names: `effect({ when: 'hover' }, setup)` fails. */
export type OptionName =
  | 'name'
  | 'when'
  | 'animate'
  | 'rebuild'
  | 'media'
  | 'reducedMotion'
  | 'on'
  | 'bleed'
  | 'presence'

// Layer, surface, pose

/** One per element with at least one live effect. */
export interface Layer {
  readonly element: Element
  readonly input: EffectInput
  /** Group at the box centre, layout plus pose. The surface and objects from `place` live here. */
  readonly root: Group
}

/** The element's single GL copy. Effects add transforms in the order they sit on the element. */
export interface Surface {
  /** A 1x1 plane on the box. Shared: read or tweak it, never dispose or reparent it. */
  readonly mesh: Mesh
  /** The material currently drawn. Replaced when the set of transforms changes. */
  readonly material: MeshBasicNodeMaterial
  /** Requests plane subdivisions. The largest request wins, default 1. */
  segments(count: number): void
  /** Moves vertices in the plane's local 1x1 space. */
  position(transform: (position: Node<'vec3'>, uv: Node<'vec2'>) => Node): Off
  /** Bends box UV (0..1, y up) before sampling. */
  uv(transform: (uv: Node<'vec2'>) => Node): Off
  /** Changes the colour. `sample(uv)` reads the element's media with crop and masks applied. */
  color(transform: (color: Node<'vec4'>, input: SurfaceInput) => Node): Off
}
/** Input of a colour transform. The final alpha is then multiplied by `u.opacity` and the clip mask. */
export interface SurfaceInput {
  /** Box UV after all `uv` transforms. */
  readonly uv: Node<'vec2'>
  /** Box UV before transforms. */
  readonly box: Node<'vec2'>
  sample(uv: Node<'vec2'>): Node<'vec4'>
}

/** Absolute target in world px (viewport centre 0,0, y up) and radians. Omitted fields keep layout. */
export interface PoseTarget {
  readonly x?: number
  readonly y?: number
  readonly z?: number
  readonly rotateX?: number
  readonly rotateY?: number
  readonly rotateZ?: number
  /** Box size in px the layer takes in the pose. */
  readonly width?: number
  readonly height?: number
  readonly scale?: number
}

export interface PlaceOptions {
  /**
   * 'box' (default) stretches a 1x1 object to the box, 'contain' scales it by min(width, height),
   * 'none' keeps px units.
   */
  readonly fit?: 'box' | 'contain' | 'none'
  /** Use this object as the element's GL copy instead of the surface mesh. */
  readonly replace?: boolean
  /** Dispose geometry, materials and textures on detach. Default true, false for shared ones. */
  readonly dispose?: boolean
}

// Definition and context

/**
 * Kernel scope of one instance. Registrations die with it. Exposes the services effects use,
 * plus `assets` when `@diorama/assets` is installed.
 */
export type EffectApp = Omit<
  AppScope<
    Pick<Services, 'stage' | 'scroll' | 'pointer' | 'anchors'> & {
      readonly render: RenderApi
      readonly assets?: Services extends { readonly assets: infer A } ? A : never
    }
  >,
  'dispose' | 'disposed'
>

/** Methods are bound, so `setup({ surface, u, place })` works. */
export interface EffectContext<P extends ParamSpec = ParamSpec> {
  readonly name: string
  readonly element: Element
  /** Live resolved values. Read them in `update`, a read in `setup` is a snapshot. */
  readonly params: Readonly<ParamsOf<P>>
  readonly u: Uniforms<P>
  /** Same object as `layer.input`. */
  readonly input: EffectInput
  readonly layer: Layer
  readonly render: RenderApi
  readonly app: EffectApp
  /** Aborted on dispose. */
  readonly signal: AbortSignal
  onDispose(cleanup: Cleanup): Off
  /** Requests one frame if the layer is visible. */
  invalidate(): void

  /** The shared GL copy of the element, created on first access. */
  readonly surface: Surface
  /** The <img> or <video> as a texture, shared by all effects on the element. Needs `media: true`. */
  readonly map: Texture
  /** Maps box UV to texture UV with the element's object-fit and object-position. Defaults to `uv()`. */
  coverUV(uv?: Node<'vec2'>): Node<'vec2'>
  /** 0..1 alpha mask at box UV for own materials: contain bars, radius, overflow clip, opacity. */
  mask(uv?: Node<'vec2'>): Node<'float'>
  /** Glues an object to the box so it follows layout and pose. Disposed with the instance. */
  place<T extends Object3D>(object: T, options?: PlaceOptions): T
  /**
   * Group pinned to the viewport (centre 0,0, world px). It does not scroll with the element,
   * ignores pose and hides while the layer is off screen. Use `place(g, { fit: 'none' })` to
   * follow the box instead.
   */
  readonly viewport: Group

  /** Live layers of matching descendants in document order. The array updates in place. */
  layers(selector: string): readonly Layer[]
  /** Blends a layer from its layout towards `target` by `weight` for this frame. Call from update. */
  pose(layer: Layer, target: PoseTarget, weight: number): void
  /** Attaches an effect owned by this instance. A selector resolves inside the element. */
  attach<Q extends ParamSpec>(
    target: string | Element,
    use: Effect<Q> | EffectUse<Q>,
  ): EffectHandle<Q>
}

/** Runs every frame while the instance is running and visible. */
export type EffectUpdate = (input: EffectInput, frame: FrameTime) => void

export type AnimatePolicy<P extends ParamSpec> =
  | 'input' // default, frames only on input (scroll, pointer, resize, param writes)
  | 'hover' // also while hovered or hover decays
  | 'visible' // every frame while on screen
  | ((ctx: EffectContext<P>) => boolean) // checked after update, true requests the next frame

export interface EffectDefinition<P extends ParamSpec> {
  /**
   * kebab-case token in `data-dio`, e.g. `image-ripple`. Defaults to the key the effect is
   * registered under (the file name when a build plugin finds it).
   */
  readonly name?: string
  /** Defaults. Their types become the param types. */
  readonly params?: P
  /** Params whose change re-runs setup. String and choice params always do. */
  readonly rebuild?: readonly (keyof P & string)[]
  /**
   * Defaults to what the effect reads. `time` animates every visible frame, `hoverTime` while
   * hovered or hover decays, neither means 'input'.
   */
  readonly animate?: AnimatePolicy<P>
  /** 'static' (default) runs with motion inputs zeroed and time frozen. 'off' skips the effect. */
  readonly reducedMotion?: 'static' | 'off'
  /** Media query the page must match or the instance is `off`. 'hover' means '(hover: hover)'. */
  readonly when?: When
  /** Needs the <img> or <video> as a texture. Implies `on: 'img, video'`, ready before setup. */
  readonly media?: boolean
  /** Selector of the elements this effect accepts. Others are skipped with a warning. */
  readonly on?: string
  /** Extra px around the box for visibility, for copies displaced past it. Default 0. */
  readonly bleed?: number
  /**
   * Page transitions. 'fade' (default) multiplies the copy's alpha by `u.presence`. With
   * 'custom' the effect reads `u.presence` or `input.presence` itself.
   */
  readonly presence?: 'fade' | 'custom'
  // biome-ignore lint/suspicious/noConfusingVoidType: setup may return nothing
  setup(ctx: EffectContext<P>): void | EffectUpdate | Promise<void | EffectUpdate>
}

/** Options of `effect()`, the definition minus params and setup. */
export type EffectOptions<P extends ParamSpec> = Omit<EffectDefinition<P>, 'params' | 'setup'>
export type EffectSetup<P extends ParamSpec> = EffectDefinition<P>['setup']

/** Frozen callable, like a plugin. Calling it returns a configured use. */
export interface Effect<P extends ParamSpec = ParamSpec> {
  (params?: Partial<ParamsOf<P>>): EffectUse<P>
  readonly name: string
  readonly defaults: Readonly<ParamsOf<P>>
  readonly '~definition': EffectDefinition<P>
}
export interface EffectUse<P extends ParamSpec = ParamSpec> {
  readonly effect: Effect<P>
  readonly params: Readonly<Partial<ParamsOf<P>>>
}

/** A media query. 'hover' is short for '(hover: hover)'. */
export type When = 'hover' | (string & {})

/** Makes reserved names fail at the call site. */
export type CheckSpec<P> = {
  readonly [K in keyof P]: K extends ReservedParam
    ? `"${K & string}" is a built-in input or reserved name, pick another`
    : K extends OptionName
      ? `"${K & string}" is an option: effect({}, { ${K & string} }, setup)`
      : P[K]
}
export type CheckParams<P> = { readonly params?: CheckSpec<P> }

// Registry, attach, instances

/** Effect types of packages by name, for typed attach and get. Extend via declaration merging. */
// biome-ignore lint/suspicious/noEmptyInterface: registry for declaration merging
export interface EffectTypes {}
/**
 * Effect types of the site's own files, written by the build plugin. A site file named like a
 * package effect (`ripple.ts`) overrides its type instead of conflicting with it.
 */
// biome-ignore lint/suspicious/noEmptyInterface: registry for declaration merging
export interface SiteEffects {}
type KnownEffects = Omit<EffectTypes, keyof SiteEffects> & SiteEffects
/** Checked once a registry is extended, any string before that. */
export type EffectName = [keyof KnownEffects] extends [never] ? string : keyof KnownEffects & string
export type SpecFor<N extends string> = N extends keyof KnownEffects
  ? KnownEffects[N] extends Effect<infer P>
    ? P
    : ParamSpec
  : ParamSpec

// biome-ignore lint/suspicious/noExplicitAny: any effect, whatever its params
export type EffectModule = Effect<any> | { readonly default: Effect<any> }
export type EffectLoader = () => Promise<EffectModule>
/**
 * A loader plus what the light part must know before three loads. Checked against the
 * definition after load. On a mismatch the definition wins and dev mode warns.
 */
export interface EffectEntry {
  readonly load: EffectLoader
  /** Param defaults known before load, so these keys are readable and tweenable right away. */
  readonly params?: ParamSpec
  readonly reducedMotion?: 'static' | 'off'
  /** Overrides the definition's `when`, e.g. `'all'` to turn ripple on for touch. */
  readonly when?: When
}
// biome-ignore lint/suspicious/noExplicitAny: any effect, whatever its params
export type EffectSource = Effect<any> | EffectLoader | EffectEntry
/** The key is the token in markup and the instance name. A definition with another name is an alias. */
export type EffectEntries = { readonly [name: string]: EffectSource }

/** A selector is a live rule, like a CSS rule. An element or a list is a fixed set, held weakly. */
export type Target = string | Element | Iterable<Element>

export interface AttachOptions {
  /** Load now instead of when near the viewport. */
  readonly eager?: boolean
  /**
   * By default the box is read live in every drawn frame and the motion watcher runs. 'frame'
   * keeps the watcher awake while visible (long JS tweens). 'layout' uses a cached box, for
   * static grids.
   */
  readonly track?: 'layout' | 'frame'
  /** Aborting it detaches the handle. */
  readonly signal?: AbortSignal
}

export type InstanceStatus =
  | 'waiting'
  | 'loading'
  | 'running'
  | 'parked'
  | 'failed'
  | 'off'
  | 'unavailable'
  | 'disposed'

/**
 * Stable facade of an (element, name) pair. The same object, with its runtime writes, survives
 * park, dispose and re-creation for the same pair (Vue KeepAlive, cached nodes).
 */
export interface EffectInstance<P extends ParamSpec = ParamSpec> {
  readonly effect: string
  readonly element: Element
  /** Reads give the resolved value. Writes go to this element's runtime layer, which beats attributes. */
  readonly params: LiveParams<P>
  /** Writes several params at once, whole tuples included. */
  set(values: Partial<ParamsOf<P>>): void
  readonly status: ReadonlySignal<InstanceStatus>
  readonly error: unknown
  /** Drops runtime writes (all, or one param) back to attributes, attach params or defaults. */
  reset(param?: keyof P & string): void
  /** Imports the definition only, without engine or setup. Resolves `false` if it cannot load. */
  loaded(): Promise<boolean>
}

/** Calling the handle detaches it, like kernel handles. `scope.onDispose(handle)` ties it to a scope. */
export interface EffectHandle<P extends ParamSpec = ParamSpec> {
  (): void
  detach(): void
  readonly effect: string
  /** Runtime layer for every covered instance, now and later. Accessor properties, so tweenable. */
  readonly params: LiveParams<P>
  set(values: Partial<ParamsOf<P>>): void
  /** Live instances only, never `disposed`. */
  readonly instances: readonly EffectInstance<P>[]
  /** Loads the definition only, so every param gets its accessor and default. Use before tweens. */
  loaded(): Promise<boolean>
  /** Settles when every current instance near the viewport has left waiting and loading. */
  ready(): Promise<void>
  reset(param?: keyof P & string): void
}

export interface Attach {
  <P extends ParamSpec>(
    target: Target,
    use: Effect<P> | EffectUse<P>,
    options?: AttachOptions,
  ): EffectHandle<P>
  <N extends EffectName>(
    target: Target,
    name: N,
    params?: Partial<ParamsOf<SpecFor<N>>>,
    options?: AttachOptions,
  ): EffectHandle<SpecFor<N>>
}

export type EffectsStatus = 'idle' | 'loading' | 'ready' | 'unavailable' | 'off'

// Copies

export type { Box }

/** A region of a picture in texture UV, y up: `texture uv = box uv * size + xy`. */
export interface Crop {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** What the copy showed in its last drawn frame, in viewport CSS px. */
export interface DrawnBox extends Box {
  readonly opacity: number
  /** border-radius in px, largest corner. */
  readonly radius: number
  /** Box it was clipped to (clipping ancestor or the `clip` override), if any. */
  readonly clip?: Box
}

export type CopyState = 'none' | 'ready' | 'ghost' | 'released'

/**
 * Control of one element's GL copy from outside its effects. Taken with `leave: 'ghost'`, the
 * copy is not parked or released when its element leaves the document. It becomes a ghost
 * owned by the taker. Every write requests a frame. One owner per element.
 */
export interface Copy {
  readonly element: Element
  /** 'none' means no drawable copy yet. 'ghost' means the element left and the copy lives on. */
  readonly state: CopyState
  /** Can be drawn now: compiled (placed objects too while veiled) and media ready. */
  readonly drawable: boolean
  /**
   * Resolves true once drawable, false if it never will be (failed, off, unavailable, released,
   * or no records after a reconcile that saw the element connected).
   */
  readonly ready: Promise<boolean>
  /** The last drawn frame, undefined if never drawn. Frozen for a ghost and while veiled. */
  readonly drawn: DrawnBox | undefined
  /** `currentSrc` the texture shows, '' without media. */
  readonly source: string
  /** In effect order. */
  readonly effects: readonly string[]
  /**
   * CSS opacity of the element and its ancestors as last read, 1 before the first read. Frozen
   * for a ghost. Still read while `box` is set, but not applied.
   */
  readonly cssOpacity: number
  /** Draws at this viewport box instead of the element's. CSS opacity is not followed while set. */
  box: Box | undefined
  /** border-radius override in px. Undefined keeps the element's, frozen once it left. */
  radius: number | undefined
  /**
   * Clips to this viewport box instead of the clipping ancestor's. Undefined keeps the
   * ancestor's, frozen relative to the copy's box once the element left or while `box` is set.
   */
  clip: Box | undefined
  /** Alpha multiplier 0..1. Default 1. */
  opacity: number
  /** `u.presence` of the copy's effects, 0..1. Default 1. */
  presence: number
  /** Hides both the copy and the DOM (`data-dio-state="entering"`) while loading goes on. */
  veil: boolean
  /** Draw level over the page. Higher levels draw above lower ones, 0 is the page. Default 0. */
  above: number
  /**
   * Region of the picture to show instead of object-fit, in texture UV (y up). Undefined follows
   * object-fit. Lets an owner move the framing smoothly during a flight.
   */
  crop: Crop | undefined
  /** The region object-fit shows in this box, undefined until the picture size is known. */
  cropAt(box: Box): Crop | undefined
  /**
   * When the element leaves the document, 'ghost' keeps the copy as a ghost and 'release' lets
   * the effects go the usual way (parked, then released) and releases this copy.
   */
  leave: 'ghost' | 'release'
  /** Idempotent. A connected element's copy goes back to its DOM life, a ghost is released. */
  release(): void
  /** Same as release, so a copy works as a kernel `Cleanup`. */
  dispose(): void
}

export interface TakeOptions {
  /** Start veiled, for a flight target or an entering element. Default false. */
  readonly veil?: boolean
  /** Default 'ghost'. */
  readonly leave?: 'ghost' | 'release'
  /**
   * The owner vouches for the copy until this aborts, and aborting releases it. Without a
   * signal, a ghost or veil with no writes for 10 s is released with a dev warning.
   */
  readonly signal?: AbortSignal
}

/** Payload of `effects:release`: a drawn copy's element left the document and nobody took it. */
export interface ReleaseRequest {
  readonly element: Element
  readonly drawn: DrawnBox
  /** The copy was in the viewport (with the effects' bleed) in its last frame. */
  readonly visible: boolean
  /** Keeps the copy as a ghost. Undefined if an earlier handler took it. */
  take(options?: Pick<TakeOptions, 'signal'>): Copy | undefined
}

export interface EffectsStats {
  readonly layers: number
  readonly ghosts: number
  readonly copies: number
  readonly instances: number
  readonly textures: number
  /** Open pooled ImageBitmaps held by copies. */
  readonly bitmaps: number
}

export interface EffectsApi {
  /** Same function as `app.attach`. */
  readonly attach: Attach
  get<N extends EffectName>(element: Element, name: N): EffectInstance<SpecFor<N>> | undefined
  instances(name?: string): readonly EffectInstance[]
  /** Adds or replaces sources. Waiting elements pick them up and replaced ones rebuild (HMR). */
  register(entries: EffectEntries): Off
  /** Turns an effect off everywhere without touching markup. The returned Off turns it back on. */
  disable(name: string): Off
  /** Reconciles now, after DOM work the observer cannot see. */
  scan(root?: ParentNode): void
  /** Observes another root such as a shadow root, and adopts the hiding stylesheet there. */
  observe(root: ParentNode): Off
  /**
   * Replaces the `pin` input of an element's layer with a 0..1 source, e.g. a ScrollTrigger's
   * progress. Read once per frame in `layout`. Off restores the built-in formula.
   */
  pin(element: Element, source: () => number): Off
  /** Boots the engine now. Resolves `false` when 3D is unavailable. */
  load(): Promise<boolean>
  readonly status: ReadonlySignal<EffectsStatus>
  /** The renderer once ready. */
  readonly render: RenderApi | undefined
  /**
   * Takes an element's GL copy. Returns an inert copy ('released', ready false) without the
   * runtime, when it is already taken, or when another app owns the element.
   */
  take(element: Element, options?: TakeOptions): Copy
  /** Counters for tests and devtools, zeros without the runtime. */
  stats(): EffectsStats
}

export interface EffectsOptions {
  /** Effects, loaders or entries by name. The key is the token in markup. */
  readonly effects: EffectEntries
  /**
   * Scanned subtree, default `document.documentElement`. A selector is re-resolved: the
   * observer watches the document and filters candidates with `el.closest(root)`.
   */
  readonly root: ParentNode | string | undefined
  /** Read `data-dio` markup. Default true. */
  readonly markup: boolean
  /**
   * 'near' (default) boots when the first effect element nears the viewport, 'eager' at
   * app:start, 'manual' only on `load()`.
   */
  readonly load: 'near' | 'eager' | 'manual'
  /** IntersectionObserver rootMargin that starts loading. Default '100% 0px', one viewport ahead. */
  readonly margin: string
  /** Downloads the engine in idle time after window load. Default true, never under Save-Data. */
  readonly prefetch: boolean
  /** Options for `render` when effects adds it. Ignored with a warning if the app already has render. */
  readonly render: Partial<RenderOptions>
  /** Plugins that need three (e.g. postfx). Each is used after render in its own transaction. */
  readonly extend: readonly (() => Promise<PluginEntry | readonly PluginEntry[]>)[]
  /** 'auto' (default) is off under Save-Data and unavailable without WebGPU or WebGL 2. */
  readonly enabled: boolean | 'auto'
}

export type EffectsPlugin = Plugin<'effects', EffectsOptions, EffectsApi>
export type AttachPlugin = Plugin<'attach', Empty, Attach>

export type EffectErrorCode =
  | 'EFFECT_DEFINITION'
  | 'EFFECT_UNKNOWN'
  | 'EFFECT_LOAD'
  | 'EFFECT_SETUP'
  | 'EFFECT_UPDATE'
  | 'EFFECT_TARGET'
  | 'EFFECT_MEDIA'
  | 'EFFECT_CORS'
  | 'EFFECT_COMPILE'
  | 'EFFECT_PARAM'
  | 'RENDER_UNAVAILABLE'
  | 'RENDER_LOST'

declare module '@diorama/core' {
  interface Services {
    effects: EffectsApi
    attach: Attach
  }
  interface Hooks {
    /** Sync, during reconcile. `request.take()` keeps the copy, `cancel()` stops later handlers. */
    'effects:release': (request: ReleaseRequest) => ReleaseRequest | Cancel
  }
  interface Events {
    'effects:status': {
      readonly element: Element
      readonly effect: string
      readonly status: InstanceStatus
      readonly error: unknown
    }
  }
}
