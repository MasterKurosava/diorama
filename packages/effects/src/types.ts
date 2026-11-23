import type {
  Anchor,
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
} from '@dioramajs/core'
import type { Box, RenderApi, RenderOptions } from '@dioramajs/render'
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

/**
 * A colour param, made by `color()`. Its uniform reads `var(--name)` and `currentColor` from the
 * element, again in every frame the element draws, so it follows a theme switch.
 */
export interface ColorParam {
  /** Brand of the param kind. */
  readonly '~kind': 'color'
  /** The default colour as written, any CSS colour, `var()` and `currentColor` included. */
  readonly value: string
}
/** A string param limited to some values, made by `oneOf()`. */
export interface ChoiceParam<T extends string = string> {
  /** Brand of the param kind. */
  readonly '~kind': 'choice'
  /** The allowed values. The first one is the default. */
  readonly values: readonly [T, ...T[]]
}
/** A plain string param whose default looks like a colour, e.g. `text('#cafe')`. */
export interface TextParam {
  /** Brand of the param kind. */
  readonly '~kind': 'string'
  /** The default string. */
  readonly value: string
}

/**
 * A param default: its type is the param type. The string 'auto' makes a number param that may
 * also be 'auto': the effect picks the value itself. It has no uniform, so a change rebuilds.
 */
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
/** Param defaults by name. */
export type ParamSpec = { readonly [name: string]: ParamDefault }

/** The value type of a param with default `D`. */
export type ParamValue<D> = D extends number
  ? number
  : D extends boolean
    ? boolean
    : D extends ColorParam | TextParam
      ? string
      : D extends ChoiceParam<infer T>
        ? T
        : D extends 'auto'
          ? number | 'auto'
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
      : P[K] extends 'auto'
        ? 'auto'
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
/** Param values by name. */
export type ParamsOf<P extends ParamSpec> = { -readonly [K in keyof P]: ParamValue<P[K]> }
/** Any param value. */
export type AnyParamValue = number | boolean | string | readonly number[]

/** Live view of a tuple param. Each component can be tweened. */
export interface ParamVector {
  /** First component. */
  x: number
  /** Second component. */
  y: number
  /** vec3 and vec4 only. */
  z?: number
  /** vec4 only. */
  w?: number
  /** Number of components. */
  readonly length: 2 | 3 | 4
  [index: number]: number
  /** Iterates the components, so `[...vector]` gives a plain tuple. */
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
  /** Left edge of the box in viewport CSS px. */
  readonly x: number
  /** Top edge of the box in viewport CSS px. */
  readonly y: number
  /** Box width in CSS px. */
  readonly width: number
  /** Box height in CSS px. */
  readonly height: number
  /** On screen this frame (box plus bleed, or posed). */
  readonly visible: boolean
  /** Pointer in element UV, y up, like `u.pointer`. */
  readonly pointer: { readonly x: number; readonly y: number }
  /** Pointer in world px, like `u.pointerWorld`. */
  readonly pointerWorld: { readonly x: number; readonly y: number }
  /** Pointer is over the box right now, without damping or reduced motion. */
  readonly over: boolean
  /** Damped 0..1 hover, like `u.hover`. */
  readonly hover: number
  /** Scroll velocity in -1..1, like `u.velocity`. */
  readonly velocity: number
  /** Scroll progress through the viewport, like `u.progress`. */
  readonly progress: number
  /** Pin progress, like `u.pin`. */
  readonly pin: number
  /** Seconds while visible, like `u.time`. */
  readonly time: number
  /** Seconds while hovered, like `u.hoverTime`. */
  readonly hoverTime: number
  /** Seconds since the previous frame. */
  readonly delta: number
  /** The page prefers reduced motion. */
  readonly reducedMotion: boolean
  /** CSS opacity with the copy's opacity and presence, like `u.opacity`. */
  readonly opacity: number
  /** 1 at rest, 0..1 while the copy enters or leaves, like `u.presence`. */
  readonly presence: number
}

/** The uniform node of a param with default `D`; strings and choices have none. */
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
/** `ctx.u`: the input uniforms and one uniform per live param. */
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
  | 'section'

/** Definition options, never valid as param names: `effect({ when: 'hover' }, setup)` fails. */
export type OptionName =
  | 'name'
  | 'when'
  | 'animate'
  | 'rebuild'
  | 'media'
  | 'burst'
  | 'reducedMotion'
  | 'on'
  | 'bleed'
  | 'presence'
  | 'quality'

// Layer, surface, pose

/** One per element with at least one live effect. */
export interface Layer {
  /** The element the layer follows. */
  readonly element: Element
  /** Inputs of the element as numbers, shared by its effects. */
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
  /**
   * Frames the media: scales it by `scale` about the box centre, then moves it by `x`, `y` (box
   * units, y up), on top of object-fit. Unlike a `uv` transform this framing is known outside
   * the shader: `copy.cropAt` includes it and a `crop` set by the copy's owner replaces it, so a
   * flight starts and lands in it. Kept until called again; called from update, it shows in that
   * frame. The framings of the element's effects combine in effect order. Default 1, 0, 0.
   */
  zoom(scale: number, x?: number, y?: number): void
}
/** Input of a colour transform. The final alpha is then multiplied by `u.opacity` and the clip mask. */
export interface SurfaceInput {
  /** Box UV after all `uv` transforms. */
  readonly uv: Node<'vec2'>
  /** Box UV before transforms. */
  readonly box: Node<'vec2'>
  /** The element's media at box UV with crop, contain and radius masks applied; `vec4(0)` without media. */
  sample(uv: Node<'vec2'>): Node<'vec4'>
  /** border-radius mask at box UV. `sample()` includes it; a transform drawing its own colour multiplies by it. */
  readonly radius: Node<'float'>
}

/** Absolute target in world px (viewport centre 0,0, y up) and radians. Omitted fields keep layout. */
export interface PoseTarget {
  /** Centre x in world px. */
  readonly x?: number
  /** Centre y in world px, y up. */
  readonly y?: number
  /** Depth in world px, towards the viewer. */
  readonly z?: number
  /** Rotation around x in radians. */
  readonly rotateX?: number
  /** Rotation around y in radians. */
  readonly rotateY?: number
  /** Rotation around z in radians. */
  readonly rotateZ?: number
  /** Box width in px the layer takes in the pose. */
  readonly width?: number
  /** Box height in px the layer takes in the pose. */
  readonly height?: number
  /** Uniform scale on top of the size. */
  readonly scale?: number
  /** border-radius in px at weight 1, blended from the element's. */
  readonly radius?: number
  /** false: ignore the clipping ancestor while weight > 0. Default true. */
  readonly clip?: boolean
  /** Draw level while weight > 0, like Copy.above. Default 0. */
  readonly above?: number
}

/** Options of `ctx.place`. */
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

/** Options of `ctx.texture`. */
export interface TextureOptions {
  /** Default 'srgb'. Depth maps and noise are 'linear'. */
  readonly colorSpace?: 'srgb' | 'linear'
  /** Default 'normal'. */
  readonly priority?: 'high' | 'normal' | 'low'
}
/** Options of `ctx.model`. */
export interface ModelOptions {
  /** Default 'normal'. */
  readonly priority?: 'high' | 'normal' | 'low'
  /** Default true: centred on its bounds, largest side 1, ready for `place(…, { fit: 'contain' })`. */
  readonly normalize?: boolean
}
/** Options of `ctx.fit`. */
export interface FitOptions {
  /** CSS object-fit. Default 'cover'. */
  readonly fit?: 'cover' | 'contain' | 'fill' | 'none' | 'scale-down'
  /** CSS object-position as fractions of the free space, [0.5, 0.5] is centre. */
  readonly position?: readonly [number, number]
}
/** A texture framed in the element's box like CSS object-fit. */
export interface Fit {
  /** Box UV (y up) to the texture's UV under the fit. */
  uv(at?: Node<'vec2'>): Node<'vec2'>
  /** 1 where the texture covers the box, 0 in contain bands, like the media's contain mask. */
  mask(at?: Node<'vec2'>): Node<'float'>
  /** The texture at box UV under the fit, clamped at its edge. Follows `set()`. */
  sample(at?: Node<'vec2'>): Node<'vec4'>
  /** Swaps the texture (the next slide): same uniforms, no recompile. */
  set(texture: Texture, options?: FitOptions): void
}

/** Quality tier, from `@dioramajs/quality`. */
export type QualityTier = 'low' | 'medium' | 'high'
/** Upper bounds of numeric params at a tier. A value above the bound is lowered, never raised. */
export type QualityCaps<P extends ParamSpec> = {
  readonly [K in keyof P as P[K] extends number ? K : never]?: number
}
/** How an effect gets cheaper: the lowest tier it runs at and its caps per tier. */
export interface QualitySpec<P extends ParamSpec> {
  /** Lowest tier the effect runs at. Below it the instance is 'off' and the element stays DOM. Default 'low'. */
  readonly min?: QualityTier
  /** Caps at the 'low' tier. */
  readonly low?: QualityCaps<P>
  /** Caps at the 'medium' tier. */
  readonly medium?: QualityCaps<P>
}

/**
 * Kernel scope of one instance. Registrations die with it. Exposes the services effects use,
 * plus `assets` when `@dioramajs/assets` is installed.
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
  /** The effect's name, the token in `data-dio`. */
  readonly name: string
  /** The element the instance runs on. */
  readonly element: Element
  /** Live resolved values. Read them in `update`, a read in `setup` is a snapshot. */
  readonly params: Readonly<ParamsOf<P>>
  /**
   * Writes params the way `instance.set` does in site code: the write beats attributes and shows
   * in `handle.params`. For an effect whose own interaction moves a param, like a gallery's index.
   */
  set(values: Partial<ParamsOf<P>>): void
  /** Input uniforms and one uniform per live param, for TSL graphs. */
  readonly u: Uniforms<P>
  /** Same object as `layer.input`. */
  readonly input: EffectInput
  /** The element's layer, shared by its effects. */
  readonly layer: Layer
  /** The renderer, scene and camera. */
  readonly render: RenderApi
  /** Kernel scope of the instance: services, listeners and systems that die with it. */
  readonly app: EffectApp
  /** Aborted on dispose. */
  readonly signal: AbortSignal
  /** Runs `cleanup` when the instance is disposed or rebuilt. */
  onDispose(cleanup: Cleanup): Off
  /**
   * Requests one frame if the layer is visible: from an event handler or a loaded resource.
   * State that moves on over several frames asks from the update by returning true.
   */
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
  /**
   * Like `viewport` (centre 0,0, world px, ignores pose, hides with the layer), but drawn after
   * every copy and `above` level, with depth test and depth write off. Grain, trails, cursors.
   */
  readonly overlay: Group
  /**
   * true hands the picture to the DOM: this phase's `replace` object and its surface share stop
   * counting as the element's copy, and `drawn` drops if no other copy is left. false takes it
   * back from the next drawn frame. Default false.
   */
  showDom(show: boolean): void
  /** A texture from the assets cache: shared, never dispose it. The lease dies with the phase. Needs `assets`. */
  texture(url: string, options?: TextureOptions): Promise<Texture>
  /** A glTF instance from the assets cache, clips in `.animations`. Starts the environment lease. Needs `assets`. */
  model(url: string, options?: ModelOptions): Promise<Object3D>
  /** CSS object-fit and object-position for any texture, e.g. the images of children. */
  fit(texture: Texture, options?: FitOptions): Fit
  /**
   * Compiles the materials of `object` before it is first drawn, on the runtime's queue with
   * every other compile. Use it instead of `renderer.compileAsync`: three keeps one
   * precompilation state per renderer, and two compiles at once fail. Rejects with the shader
   * error; does nothing once the phase is gone.
   */
  compile(object: Object3D): Promise<void>
  /** The tier from `@dioramajs/quality`, 'high' without it. A read outside update re-runs setup on a change. */
  readonly quality: QualityTier
  /**
   * The scroll section the element plays in: the closest `[data-dio-section]` ancestor, else the
   * parent of the closest `position: sticky` ancestor, else the element itself. Its `pin` runs
   * while a sticky stage is held. Shared, updated every frame and released with the phase: never
   * dispose it. Looked up again when the element re-measures, so call it where you read it.
   */
  section(): Anchor
  /**
   * Lifts the canvas above every element of the page, into the browser's top layer, until the
   * returned Off runs or the phase closes. Calls are counted: the canvas comes down with the last
   * Off. For full-screen views over sticky headers and chat widgets; a modal `<dialog>` shown
   * after it stays above the canvas. Without the Popover API the canvas takes the highest
   * `z-index` instead, which elements with that same value still beat.
   */
  raise(): Off

  /** Live layers of matching descendants in document order. The array updates in place. */
  layers(selector: string): readonly Layer[]
  /**
   * Blends a layer from its layout towards `target` by `weight` for this frame. Call from update.
   * A taken copy wins: with a `box` only the pose's `above` applies, and the copy's own `radius`,
   * `clip` and non-zero `above` beat the pose's.
   */
  pose(layer: Layer, target: PoseTarget, weight: number): void
  /** Attaches an effect owned by this instance. A selector resolves inside the element. */
  attach<Q extends ParamSpec>(
    target: string | Element,
    use: Effect<Q> | EffectUse<Q>,
  ): EffectHandle<Q>
}

/**
 * Runs every frame while the instance is running and visible. Return `true` to ask for the next
 * frame while state kept in JavaScript still moves (a damped value, a fade, a simulation), and
 * `false` once it has settled. Without an `animate` option a returned boolean decides alone, so
 * reading `input.delta` for the motion does not draw every frame; return one on every path. With
 * `animate`, `true` adds frames to the policy. Returning nothing leaves it to the policy. `true`
 * is honoured under reduced motion too: settle at once when `input.reducedMotion` is set.
 */
// biome-ignore lint/suspicious/noConfusingVoidType: an update may return nothing
export type EffectUpdate = (input: EffectInput, frame: FrameTime) => boolean | void

/**
 * When an effect asks for frames beyond input and its update's answer:
 * - 'input' (default): frames only on input (scroll, pointer, resize, param writes).
 * - 'hover': also while hovered or hover decays.
 * - 'visible': every frame while on screen.
 * - a function: checked after update, true requests the next frame. The runtime also asks it
 *   between frames whether a burst in `ctx.overlay` still flies, which an update's answer cannot
 *   tell before the next frame (a click that starts a burst and hides its element).
 * - `{ fps }`: time frames at most `fps` a second while visible, 0 means none. Input frames
 *   run at full rate.
 */
export type AnimatePolicy<P extends ParamSpec> =
  | 'input'
  | 'hover'
  | 'visible'
  | ((ctx: EffectContext<P>) => boolean)
  | { readonly fps: number | ((ctx: EffectContext<P>) => number) }

/** What `defineEffect` takes: the params, the options and `setup`. */
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
   * Defaults to the update's answer when it returns a boolean, else to what the effect reads:
   * `time` animates every visible frame, `hoverTime` while hovered or hover decays, neither
   * means 'input'.
   */
  readonly animate?: AnimatePolicy<P>
  /** 'static' (default) runs with motion inputs zeroed and time frozen. 'off' skips the effect. */
  readonly reducedMotion?: 'static' | 'off'
  /**
   * Media query the page must match or the instance is `off`. 'hover' means '(hover: hover)'.
   * An element's `data-dio-when` (or `data-dio-<name>-when`) and the `attach` option override it.
   */
  readonly when?: When
  /**
   * Needs the <img> or <video> as a texture. Implies `on: 'img, video'`, ready before setup.
   * 'optional' reads it when the element is one and runs without it on other elements.
   */
  readonly media?: boolean | 'optional'
  /** Selector of the elements this effect accepts. Others are skipped with a warning. */
  readonly on?: string
  /**
   * Objects in `ctx.overlay` outlive a hidden or removed element while the effect still asks
   * for frames itself (a burst): its update returned true, or its `animate` function says so.
   * false ties them to the element: a pane or a layer of the page that only animates its state.
   * Default true.
   */
  readonly burst?: boolean
  /** Extra px around the box for visibility, for copies displaced past it. Default 0. */
  readonly bleed?: number
  /**
   * Page transitions. 'fade' (default) multiplies the copy's alpha by `u.presence`. With
   * 'custom' the effect reads `u.presence` or `input.presence` itself.
   */
  readonly presence?: 'fade' | 'custom'
  /** How the effect gets cheaper on weaker GPUs. Read by the runtime and by the docs. */
  readonly quality?: QualitySpec<P>
  /** Builds the effect once per instance. May return an update that runs every drawn frame. */
  // biome-ignore lint/suspicious/noConfusingVoidType: setup may return nothing
  setup(ctx: EffectContext<P>): void | EffectUpdate | Promise<void | EffectUpdate>
}

/** Options of `effect()`, the definition minus params and setup. */
export type EffectOptions<P extends ParamSpec> = Omit<EffectDefinition<P>, 'params' | 'setup'>
/** The `setup` function of an effect. */
export type EffectSetup<P extends ParamSpec> = EffectDefinition<P>['setup']

/** Frozen callable, like a plugin. Calling it returns a configured use. */
export interface Effect<P extends ParamSpec = ParamSpec> {
  (params?: Partial<ParamsOf<P>>): EffectUse<P>
  /** The token in `data-dio`. */
  readonly name: string
  /** Param defaults as values. */
  readonly defaults: Readonly<ParamsOf<P>>
  /** The definition it was made from, for the runtime and tools. */
  readonly '~definition': EffectDefinition<P>
}
/** An effect with params, as `ripple({ strength: 2 })` returns it. */
export interface EffectUse<P extends ParamSpec = ParamSpec> {
  /** The effect. */
  readonly effect: Effect<P>
  /** Params given at the call, over the defaults. */
  readonly params: Readonly<Partial<ParamsOf<P>>>
}

/** A media query. 'hover' is short for '(hover: hover)'. */
export type When = 'hover' | (string & {})

/** Makes reserved names fail at the call site. */
export type CheckSpec<P> = {
  readonly [K in keyof P]: K extends ReservedAttr
    ? `"${K & string}" is a built-in input or reserved name, pick another`
    : K extends keyof InputUniforms
      ? // A choice has no uniform, so it may share a name with an input (the `motion` key).
        P[K] extends ChoiceParam<string>
        ? P[K]
        : `"${K & string}" is a built-in input or reserved name, pick another`
      : K extends OptionName
        ? `"${K & string}" is an option: effect({}, { ${K & string} }, setup)`
        : P[K]
}
/** Makes reserved param names fail in `defineEffect`. */
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
/** The params of a known effect by name, `ParamSpec` for any other. */
export type SpecFor<N extends string> = N extends keyof KnownEffects
  ? KnownEffects[N] extends Effect<infer P>
    ? P
    : ParamSpec
  : ParamSpec

/** A module whose default export is an effect, or the effect itself. */
// biome-ignore lint/suspicious/noExplicitAny: any effect, whatever its params
export type EffectModule = Effect<any> | { readonly default: Effect<any> }
/** A lazy import of an effect module. */
export type EffectLoader = () => Promise<EffectModule>
/**
 * A loader plus what the light part must know before three loads. Checked against the
 * definition after load. On a mismatch the definition wins and dev mode warns.
 */
export interface EffectEntry {
  /** Imports the effect module. */
  readonly load: EffectLoader
  /** Param defaults known before load, so these keys are readable and tweenable right away. */
  readonly params?: ParamSpec
  /** Overrides the definition's `reducedMotion`. 'off' skips loading under reduced motion. */
  readonly reducedMotion?: 'static' | 'off'
  /** Overrides the definition's `when`, e.g. `'all'` to turn ripple on for touch. */
  readonly when?: When
  /** Overrides the definition's `presence` (a GLSL file's pragma, a patch). */
  readonly presence?: 'fade' | 'custom'
  /**
   * The effect plays an intro: an element in view when its instance is created is hidden
   * (`data-dio-state="entering"`) until the effect draws it, at most 3 s, so the intro plays
   * on the first screen too instead of the visitor seeing the DOM first. A function decides per
   * element, e.g. from its markup.
   */
  readonly intro?: boolean | ((element: Element) => boolean)
  /**
   * The entry replaces a built-in effect of `@dioramajs/diorama` on purpose, so `start()` does not warn
   * `EFFECT_OVERRIDE` in development. The registry ignores it.
   */
  readonly override?: boolean
}
/** The shared loader of a package's entry map; see `group()`. */
export interface EffectGroup {
  readonly load: () => Promise<EffectEntries>
}
/**
 * An entry whose metadata comes with its package's map, loaded on first need. Its
 * own fields lie over the map's entry, like a site's patch.
 */
export interface EffectGroupEntry extends Omit<EffectEntry, 'load'> {
  readonly group: EffectGroup
}
/** An effect, a loader, an entry with metadata or an entry of a lazy group. */
export type EffectSource =
  // biome-ignore lint/suspicious/noExplicitAny: any effect, whatever its params
  Effect<any> | EffectLoader | EffectEntry | EffectGroupEntry
/** The key is the token in markup and the instance name. A definition with another name is an alias. */
export type EffectEntries = { readonly [name: string]: EffectSource }

/** A selector is a live rule, like a CSS rule. An element or a list is a fixed set, held weakly. */
export type Target = string | Element | Iterable<Element>

/** Options of `attach`. */
export interface AttachOptions {
  /** Load now instead of when near the viewport. */
  readonly eager?: boolean
  /**
   * By default the box is read live in every drawn frame and the motion watcher runs. 'frame'
   * keeps the watcher awake while visible (long JS tweens). 'layout' uses a cached box, for
   * static grids.
   */
  readonly track?: 'layout' | 'frame'
  /**
   * Media query the effect runs under on these elements, 'hover' for `(hover: hover)`, 'all' for
   * everywhere. Beats the effect's own `when`; `data-dio-when` on the element beats it.
   */
  readonly when?: When
  /** Aborting it detaches the handle. */
  readonly signal?: AbortSignal
}

/** Where an instance is in its life. */
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
  /** The effect's name. */
  readonly effect: string
  /** The element it runs on. */
  readonly element: Element
  /** Reads give the resolved value. Writes go to this element's runtime layer, which beats attributes. */
  readonly params: LiveParams<P>
  /** Writes several params at once, whole tuples included. */
  set(values: Partial<ParamsOf<P>>): void
  /** Where the instance is in its life. */
  readonly status: ReadonlySignal<InstanceStatus>
  /** Why it failed, when `status` is 'failed'. */
  readonly error: unknown
  /** Drops runtime writes (all, or one param) back to attributes, attach params or defaults. */
  reset(param?: keyof P & string): void
  /** Imports the definition only, without engine or setup. Resolves `false` if it cannot load. */
  loaded(): Promise<boolean>
}

/** Calling the handle detaches it, like kernel handles. `scope.onDispose(handle)` ties it to a scope. */
export interface EffectHandle<P extends ParamSpec = ParamSpec> {
  (): void
  /** Detaches every instance the handle covers. Same as calling it. */
  detach(): void
  /** The effect's name. */
  readonly effect: string
  /** Runtime layer for every covered instance, now and later. Accessor properties, so tweenable. */
  readonly params: LiveParams<P>
  /** Writes several params at once, whole tuples included. */
  set(values: Partial<ParamsOf<P>>): void
  /** Live instances only, never `disposed`. */
  readonly instances: readonly EffectInstance<P>[]
  /** Loads the definition only, so every param gets its accessor and default. Use before tweens. */
  loaded(): Promise<boolean>
  /** Settles when every current instance near the viewport has left waiting and loading. */
  ready(): Promise<void>
  /** Drops the handle's writes (all, or one param) back to attributes, attach params or defaults. */
  reset(param?: keyof P & string): void
}

/** `app.attach`: puts an effect on elements by selector, element or list. */
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

/** The state of the engine. */
export type EffectsStatus = 'idle' | 'loading' | 'ready' | 'unavailable' | 'off'

// Copies

/** A viewport box in CSS px. */
export type { Box }

/** A region of a picture in texture UV, y up: `texture uv = box uv * size + xy`. */
export interface Crop {
  /** Left edge in texture UV. */
  readonly x: number
  /** Bottom edge in texture UV. */
  readonly y: number
  /** Width in texture UV. */
  readonly width: number
  /** Height in texture UV. */
  readonly height: number
}

/** What the copy showed in its last drawn frame, in viewport CSS px. */
export interface DrawnBox extends Box {
  /** Alpha it was drawn with. */
  readonly opacity: number
  /** border-radius in px, largest corner. */
  readonly radius: number
  /** Box it was clipped to (clipping ancestor or the `clip` override), if any. */
  readonly clip?: Box
}

/** Where the element's own effects pose its copy, in viewport CSS px. */
export interface PosedBox extends Box {
  /** border-radius in px, blended by the pose. */
  readonly radius: number
  /** false while the pose lifts the clipping ancestor's clip (`clip: false`). */
  readonly clip: boolean
}

/** The state of a taken copy. */
export type CopyState = 'none' | 'ready' | 'ghost' | 'released'

/**
 * Control of one element's GL copy from outside its effects. Taken with `leave: 'ghost'`, the
 * copy is not parked or released when its element leaves the document. It becomes a ghost
 * owned by the taker. Every write requests a frame. One owner per element.
 */
export interface Copy {
  /** The element whose copy this is. */
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
  /**
   * Where the element's effects pose this copy (`ctx.pose` on its layer) as of the last frame,
   * worked out from the element's box even while `box` holds the copy elsewhere, so an owner can
   * let go of it there without a jump. Undefined while not posed, and for a ghost.
   */
  readonly posed: PosedBox | undefined
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
  /**
   * Draw level over the page. Higher levels draw above lower ones, 0 is the page. Default 0.
   * While a copy above 0 is drawn, a canvas under the page goes into the top layer, over the page.
   */
  above: number
  /**
   * Region of the picture to show instead of object-fit and the effects' `surface.zoom`, in
   * texture UV (y up). Undefined follows them. Lets an owner move the framing smoothly during a
   * flight.
   */
  crop: Crop | undefined
  /**
   * The region object-fit and the effects' `surface.zoom` show in this box, undefined until the
   * picture size is known.
   */
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

/** Options of `app.effects.take`. */
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
  /** The element that left. */
  readonly element: Element
  /** Where and how the copy was last drawn. */
  readonly drawn: DrawnBox
  /** The copy was in the viewport (with the effects' bleed) in its last frame. */
  readonly visible: boolean
  /** Keeps the copy as a ghost. Undefined if an earlier handler took it. */
  take(options?: Pick<TakeOptions, 'signal'>): Copy | undefined
}

/** Counters of `app.effects.stats()`. */
export interface EffectsStats {
  /** Layers of elements with live effects. */
  readonly layers: number
  /** Copies whose element left the document. */
  readonly ghosts: number
  /** Copies taken through `take`. */
  readonly copies: number
  /** Instances with a live phase. */
  readonly instances: number
  /** Media textures held by layers. */
  readonly textures: number
  /** Open pooled ImageBitmaps held by copies. */
  readonly bitmaps: number
}

/** The `effects` service, `app.effects`. */
export interface EffectsApi {
  /** Same function as `app.attach`. */
  readonly attach: Attach
  /** The instance of an effect on an element, if any. */
  get<N extends EffectName>(element: Element, name: N): EffectInstance<SpecFor<N>> | undefined
  /** Live instances, of one effect or all. */
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
  /** The state of the engine. */
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

/** Options of the `effects` preset. */
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
  /**
   * Plugins that need three (e.g. postfx, quality). Each is used after render in its own
   * transaction: `() => import('@dioramajs/quality').then((m) => m.quality())`.
   */
  readonly extend: readonly (() =>
    | PluginEntry
    | readonly PluginEntry[]
    | Promise<PluginEntry | readonly PluginEntry[]>)[]
  /**
   * 'auto' (default) is off under Save-Data and unavailable without WebGPU or WebGL 2. `true`
   * ignores Save-Data but not a missing GPU: the page stays plain, as with 'auto'. `false` is off.
   */
  readonly enabled: boolean | 'auto'
}

/** The `effects` plugin. */
export type EffectsPlugin = Plugin<'effects', EffectsOptions, EffectsApi>
/** The `attach` plugin, which gives `app.attach`. */
export type AttachPlugin = Plugin<'attach', Empty, Attach>

/** Codes of `EffectError`. */
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

declare module '@dioramajs/core' {
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
