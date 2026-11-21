// Runtime for converted shaders. Binds uniforms to effect inputs and params, loads textures and
// mounts the stages on the element's surface or on a plane.
import type { Empty, Off } from '@dioramajs/core'
import {
  type CheckParams,
  defineEffect,
  type Effect,
  type EffectContext,
  type EffectDefinition,
  EffectError,
  type EffectUpdate,
  type ParamDefault,
  type ParamSpec,
  type WidenSpec,
} from '@dioramajs/effects'
import * as TSL from 'three/tsl'
import {
  DataTexture,
  Mesh,
  MeshBasicNodeMaterial,
  NoColorSpace,
  type Node,
  PlaneGeometry,
  SRGBColorSpace,
  type Texture,
  TextureLoader,
} from 'three/webgpu'
import { isInput, similar, VECTOR_SIZES } from './names'
import type {
  Binding,
  GlslShader,
  GlslType,
  SamplerLike,
  ShaderFunction,
  ShaderInput,
  ShaderScope,
} from './types'

// biome-ignore lint/suspicious/noExplicitAny: TSL types are per node type; this glue is generic over GLSL types
type AnyNode = any
type NodeFunction = (...args: unknown[]) => AnyNode
const tsl = TSL as unknown as {
  [K in
    | 'float'
    | 'int'
    | 'vec2'
    | 'vec3'
    | 'vec4'
    | 'texture'
    | 'varyingProperty'
    | 'sRGBTransferEOTF'
    | 'sRGBTransferOETF'
    | 'clamp'
    | 'select'
    | 'any'
    | 'notEqual']: NodeFunction
} & { screenDPR: AnyNode; positionLocal: AnyNode }
const {
  float,
  int,
  vec2,
  vec3,
  vec4,
  texture,
  varyingProperty,
  sRGBTransferEOTF,
  sRGBTransferOETF,
  clamp,
  select,
  any,
  notEqual,
} = tsl
const { screenDPR, positionLocal } = tsl
const uvNode = TSL.uv as () => AnyNode

declare const process: { env: Record<string, string | undefined> } | undefined
const DEV: boolean =
  (import.meta as { env?: { DEV?: boolean } }).env?.DEV ??
  (typeof process !== 'undefined' && process.env.NODE_ENV !== 'production')

/** One converted shader, or a vertex and a fragment shader. */
export type GlslSource<P extends ParamSpec = ParamSpec> =
  | GlslShader<P>
  | { readonly vertex?: GlslShader<P>; readonly fragment?: GlslShader<P> }

/** A URL, a shared Texture (never disposed by us), or a loader whose Texture the instance owns. */
export type TextureSource = Texture | string | ((signal: AbortSignal) => Promise<Texture>)

/** Options of `glslEffect`: definition fields plus how uniforms are bound. */
export interface GlslEffectOptions<P extends ParamSpec>
  extends Partial<Omit<EffectDefinition<P>, 'setup' | 'params' | 'name' | 'media'>> {
  /** Default: the shader's name. */
  readonly name?: string
  /** Binding overrides, keyed by GLSL uniform name. */
  readonly uniforms?: {
    readonly [uniform: string]: Binding | ((ctx: EffectContext<P>) => Node)
  }
  /** Sources for `texture:` bindings. Each URL is loaded once and shared. */
  readonly textures?: { readonly [uniform: string]: TextureSource }
  /** Bodies for GLSL prototypes, written in TSL. */
  readonly functions?: { readonly [name: string]: ShaderFunction }
  /** Overrides the shader's colour space. */
  readonly colorSpace?: 'srgb' | 'linear'
  /**
   * `surface` draws on the element's GL copy and stacks with other effects. `plane` adds a plane
   * over the box. Defaults to `surface` when the shader reads the element's image.
   */
  readonly mode?: 'surface' | 'plane'
  /** Runs after the shader is bound. May return a per-frame update. */
  // biome-ignore lint/suspicious/noConfusingVoidType: setup may return nothing
  setup?(ctx: EffectContext<P>): void | EffectUpdate | Promise<void | EffectUpdate>
}

/** Definition fields glslEffect fills in. The rest pass through from the options. */
type Inferred = 'name' | 'params' | 'media' | 'animate' | 'bleed' | 'setup'

/** Options of `applyShader` and `shaderNode`. */
export type ApplyOptions = Pick<
  GlslEffectOptions<ParamSpec>,
  'uniforms' | 'textures' | 'functions' | 'colorSpace'
>

/** The glue's params override the shader's. An untyped (wildcard `?shader`) shader adds none. */
export type MergeParams<S extends ParamSpec, O extends ParamSpec> = ParamSpec extends S
  ? O
  : Omit<S, keyof O> & O

interface Entry {
  refs: number
  texture: Texture | undefined
  promise: Promise<Texture>
}
const cache = new Map<string, Entry>()

/** Loads texture URLs. Tests replace it. */
export const textureLoader: { load(url: string): Promise<Texture> } = {
  load: (url) => new TextureLoader().loadAsync(url),
}

/** Live cache entries by URL. Exposed for tests. */
export const textureCache: ReadonlyMap<string, { readonly refs: number }> = cache

interface Held {
  readonly promise: Promise<Texture>
  release(): void
}

/** One load per URL. The last release disposes it, as does a load that lands with no users. */
function acquire(url: string): Held {
  let entry = cache.get(url)
  if (!entry) {
    // Safe to reference `fresh` in the callbacks: they run asynchronously.
    const fresh: Entry = {
      refs: 0,
      texture: undefined,
      promise: textureLoader.load(url).then(
        (map) => {
          // Raw values as in a ShaderMaterial, so data maps aren't decoded.
          map.colorSpace = NoColorSpace
          fresh.texture = map
          if (fresh.refs === 0) {
            map.dispose()
            if (cache.get(url) === fresh) cache.delete(url)
          }
          return map
        },
        (error: unknown) => {
          if (cache.get(url) === fresh) cache.delete(url)
          throw error
        },
      ),
    }
    cache.set(url, fresh)
    entry = fresh
  }
  const held = entry
  held.refs++
  let done = false
  return {
    promise: held.promise,
    release() {
      if (done) return
      done = true
      held.refs--
      if (held.refs === 0 && held.texture) {
        held.texture.dispose()
        if (cache.get(url) === held) cache.delete(url)
      }
    },
  }
}

/** Stops waiting on abort. The load itself can't be cancelled. */
function until<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise((resolve, reject) => {
    const abort = (): void => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

let empty: Texture | undefined
/** Transparent 1x1 texture, used while a per-element image is unset. */
const transparent = (): Texture => {
  if (!empty) {
    empty = new DataTexture(new Uint8Array(4), 1, 1)
    empty.needsUpdate = true
  }
  return empty
}

/** GLSL expects raw values, so a shared sRGB texture is read through a NoColorSpace clone. */
function rawView(map: Texture, colorSpace: 'srgb' | 'linear', track: Track): Texture {
  if (map.colorSpace !== SRGBColorSpace || colorSpace !== 'srgb') return map
  const raw = map.clone()
  raw.colorSpace = NoColorSpace
  track(() => raw.dispose())
  return raw
}

const report = (ctx: Context, error: unknown, what: string): void => {
  if (ctx.signal.aborted) return
  ctx.app.report(
    error instanceof EffectError
      ? error
      : new EffectError('EFFECT_SETUP', `${what} failed`, {
          effect: ctx.name,
          element: ctx.element,
          cause: error,
        }),
    `effect:${ctx.name}`,
  )
}

/** Returns a node right away since shaderNode is sync. URLs and loaders fill it in later. */
function lateTexture(
  ctx: Context,
  source: TextureSource | undefined,
  colorSpace: 'srgb' | 'linear',
): Node {
  if (source === undefined || source === '') return texture(transparent())
  if (typeof source === 'object') return texture(rawView(source, colorSpace, ctx.onDispose))
  const node = texture(transparent()) as Node & { value: Texture }
  const done = (map: Texture): void => {
    if (ctx.signal.aborted) return
    node.value = map
    ctx.invalidate()
  }
  if (typeof source === 'string') {
    const held = acquire(source)
    ctx.onDispose(() => held.release())
    held.promise.then(done, (error: unknown) => report(ctx, error, `texture ${source}`))
  } else {
    source(ctx.signal).then(
      (map) => {
        ctx.onDispose(() => map.dispose())
        done(map)
      },
      (error: unknown) => report(ctx, error, 'a texture loader'),
    )
  }
  return node
}

type Track = (release: () => void) => unknown
/** Read the element's image like a ClampToEdge sampler. */
const edge = (at: Node): Node<'vec2'> => clamp(at, 0, 1)

// An sRGB shader works on sRGB values, as in a ShaderMaterial. Its input is encoded and its
// output decoded back to linear.
const intoShader = (color: Node, srgb: boolean): Node<'vec4'> => {
  const rgba = color as Node<'vec4'>
  return srgb ? vec4(sRGBTransferOETF(rgba.rgb), rgba.a) : rgba
}
const fromShader = (color: Node, srgb: boolean): Node<'vec4'> => {
  const rgba = color as Node<'vec4'>
  return srgb ? vec4(sRGBTransferEOTF(rgba.rgb), rgba.a) : rgba
}

const ZERO: Record<string, () => Node> = {
  float: () => float(0),
  int: () => int(0),
  bool: () => float(0).greaterThan(0.5),
  vec2: () => vec2(0),
  vec3: () => vec3(0),
  vec4: () => vec4(0),
}

type Context = EffectContext<ParamSpec>
type Uniforms = Record<string, AnyNode>

/**
 * Params are floats: int casts, bool is `> 0.5`. A colour is a vec3 uniform whose `nodeType`
 * is resolved only at build, so its Color value tells it apart; as a vec4 it gets alpha 1.
 */
function paramValue(node: AnyNode, type: GlslType): Node {
  if (type === 'int') return int(node)
  if (type === 'bool') return (node as Node<'float'>).greaterThan(0.5)
  return type === 'vec4' && node.value?.isColor ? vec4(node, 1) : node
}

/**
 * Node for any binding except `media`. The caller loads textures because `mount` awaits them
 * and `shaderNode` must stay sync. A sampler param is the element's image URL. A param the
 * context lacks throws, so `applyShader` and `shaderNode` fail alike.
 */
function bindingNode<T>(
  ctx: Context,
  shader: GlslShader,
  options: ApplyOptions,
  type: GlslType,
  bind: Binding,
  textureOf: (source: TextureSource | undefined) => T,
): Node | T {
  if (bind === 'none')
    return type === 'sampler2D' ? texture(transparent()) : (ZERO[type] as () => Node)()
  if (bind.startsWith('input:')) return inputNode(ctx, bind.slice(6) as ShaderInput)
  if (bind.startsWith('texture:')) {
    const key = bind.slice(8)
    return textureOf(options.textures?.[key] ?? shader.textures[key])
  }
  const param = bind.slice(6)
  const params = ctx.params as Record<string, unknown>
  const node = (ctx.u as unknown as Uniforms)[param]
  if (type === 'sampler2D' ? !(param in params) : !node) {
    const what = param in params ? `not a ${type} param` : 'not a param'
    throw new EffectError(
      'EFFECT_SETUP',
      `${shader.file}: "${param}" is ${what} of "${ctx.name}"`,
      {
        effect: ctx.name,
        element: ctx.element,
      },
    )
  }
  if (type !== 'sampler2D') return paramValue(node, type)
  const url = params[param]
  return textureOf(typeof url === 'string' ? url : '')
}

function inputNode(ctx: Context, name: ShaderInput): Node {
  const uniforms = ctx.u as unknown as Uniforms
  const size = uniforms.size as Uniforms[string]
  const sizePx = (): Node => size.mul(screenDPR)
  const pointer = uniforms.pointer as Uniforms[string]
  switch (name) {
    case 'pointerNdc':
      return pointer.mul(2).sub(1)
    case 'pointerPx':
      return pointer.mul(sizePx())
    case 'mouse4':
      return vec4(pointer.mul(sizePx()), 0, 0)
    case 'size3':
      return vec3(size, 1)
    case 'sizePx':
      return sizePx()
    case 'sizePx3':
      return vec3(sizePx(), 1)
    default:
      return uniforms[name] as Node
  }
}

const shadersOf = (source: GlslSource): { fragment?: GlslShader; vertex?: GlslShader } =>
  '~glsl' in source
    ? source.stage === 'position'
      ? { vertex: source }
      : { fragment: source }
    : { fragment: source.fragment, vertex: source.vertex }

interface Bound {
  readonly fragment: Record<string, Node | SamplerLike>
  readonly vertex: Record<string, Node | SamplerLike>
  readonly varyings: Record<string, Node>
}

/** Binds the uniforms of both stages. Texture loads are awaited and abort with the instance. */
async function bindAll(
  ctx: Context,
  stages: { fragment?: GlslShader; vertex?: GlslShader },
  options: ApplyOptions,
  colorSpace: 'srgb' | 'linear',
  track: Track,
): Promise<Bound> {
  const loaded = new Map<string, Node>()
  const texNode = async (uniform: string, source: TextureSource | undefined): Promise<Node> => {
    const hit = loaded.get(uniform)
    if (hit) return hit
    let map: Texture
    if (source === undefined || source === '') map = transparent()
    else if (typeof source === 'string') {
      const held = acquire(source)
      track(() => held.release())
      map = await until(held.promise, ctx.signal)
    } else if (typeof source === 'function') {
      const owned = await source(ctx.signal)
      track(() => owned.dispose())
      map = owned
    } else map = rawView(source, colorSpace, track)
    const node: Node = texture(map)
    loaded.set(uniform, node)
    return node
  }

  const bindStage = async (
    shader: GlslShader | undefined,
  ): Promise<Record<string, Node | SamplerLike>> => {
    const nodes: Record<string, Node | SamplerLike> = {}
    if (!shader) return nodes
    for (const [name, info] of Object.entries(shader.uniforms)) {
      const override = options.uniforms?.[name]
      if (typeof override === 'function') {
        nodes[name] = override(ctx)
        continue
      }
      const bind = override ?? info.bind
      // Placeholder. scopeOf binds the element's image per stage.
      if (bind === 'media') {
        nodes[name] = { sample: () => vec4(0) }
        continue
      }
      nodes[name] = await bindingNode(ctx, shader, options, info.type, bind, (source) =>
        texNode(name, source),
      )
    }
    return nodes
  }

  const varyings: Record<string, Node> = {}
  const id = ctx.name.replace(/[^a-zA-Z0-9]/g, '_')
  const types = { ...stages.fragment?.varyings, ...stages.vertex?.varyings }
  for (const [name, type] of Object.entries(types)) {
    varyings[name] = varyingProperty(type, `dio_${id}_${name}`)
  }
  return {
    fragment: await bindStage(stages.fragment),
    vertex: await bindStage(stages.vertex),
    varyings,
  }
}

function scopeOf(
  bound: Bound,
  stage: 'fragment' | 'vertex',
  ctx: Context,
  options: ApplyOptions,
  at: { uv: Node; box: Node; position?: Node },
  media?: SamplerLike,
  mediaName?: string,
): ShaderScope {
  const uniforms = { ...bound[stage] }
  if (media && mediaName) uniforms[mediaName] = media
  const sizePx = (ctx.u.size as unknown as Uniforms[string]).mul(screenDPR)
  return {
    uniforms,
    uv: at.uv as Node<'vec2'>,
    box: at.box as Node<'vec2'>,
    fragCoord: vec4((at.box as Uniforms[string]).mul(sizePx), 0, 1) as Node<'vec4'>,
    position: at.position as Node<'vec3'> | undefined,
    varyings: bound.varyings,
    functions: options.functions ?? {},
  }
}

const mediaOf = (shader: GlslShader | undefined): string | undefined =>
  shader && Object.entries(shader.uniforms).find(([, info]) => info.bind === 'media')?.[0]

/**
 * Mounts both stages on the surface or a plane once textures are bound. A vertex shader gets a
 * grid of at least 64 segments, or `minSegments` if larger.
 */
async function mount(
  ctx: Context,
  stages: { fragment?: GlslShader; vertex?: GlslShader },
  options: ApplyOptions & { readonly mode?: 'surface' | 'plane' },
  minSegments: number,
): Promise<Off> {
  const { fragment, vertex } = stages
  const segments = Math.max(minSegments, vertex ? Math.max(64, vertex.segments) : 1)
  const colorSpace = options.colorSpace ?? fragment?.colorSpace ?? 'srgb'
  const srgb = colorSpace === 'srgb'
  const offs: Off[] = []
  let closed = false
  const close: Off = () => {
    if (closed) return
    closed = true
    for (const off of offs.splice(0).reverse()) off()
  }
  let bound: Bound
  try {
    bound = await bindAll(ctx, stages, options, colorSpace, (release) => offs.push(release))
    if (ctx.signal.aborted) throw ctx.signal.reason
  } catch (error) {
    close()
    throw error
  }
  const media = mediaOf(fragment)
  const mode = options.mode ?? (media || !fragment ? 'surface' : 'plane')
  if (mode === 'plane') {
    const plane = uvNode()
    // The box mask (contain bars, radius, clip, opacity) is applied once, as the plane's opacity.
    const sample: SamplerLike = {
      sample: (at) => texture(ctx.map, ctx.coverUV(edge(at))) as unknown as Node<'vec4'>,
    }
    const material = new MeshBasicNodeMaterial({ transparent: true })
    if (fragment) {
      const result = fragment.build(
        scopeOf(
          bound,
          'fragment',
          ctx,
          options,
          { uv: plane, box: plane },
          media
            ? {
                sample: (at) => intoShader(sample.sample(at), srgb),
              }
            : undefined,
          media,
        ),
      )
      material.colorNode = (
        fragment.stage === 'uv' ? sample.sample(result as Node<'vec2'>) : fromShader(result, srgb)
      ) as AnyNode
    }
    if (vertex)
      material.positionNode = vertex.build(
        scopeOf(bound, 'vertex', ctx, options, { uv: plane, box: plane, position: positionLocal }),
      )
    material.opacityNode = ctx.mask()
    ctx.place(new Mesh(new PlaneGeometry(1, 1, segments, segments), material))
    return close
  }
  const surface = ctx.surface
  if (vertex) {
    surface.segments(segments)
    offs.push(
      surface.position((position, uv) =>
        vertex.build(scopeOf(bound, 'vertex', ctx, options, { uv, box: uv, position })),
      ),
    )
  }
  if (fragment?.stage === 'uv') {
    let warped: Node | undefined
    offs.push(
      surface.uv((uv) => {
        warped = fragment.build(scopeOf(bound, 'fragment', ctx, options, { uv, box: uv }))
        return warped
      }),
      // The surface samples at the last uv transform's coordinate. When that is ours, clamp the
      // image to its edges. A later uv transform still sees the raw coordinate.
      surface.color((color, input) => {
        if (!warped || input.uv !== warped) return color
        const at = edge(warped)
        return select(any(notEqual(warped, at)), input.sample(at), color)
      }),
    )
  } else if (fragment) {
    offs.push(
      surface.color((_, input) => {
        const read: SamplerLike = {
          sample: (at) => intoShader(input.sample(edge(at)), srgb),
        }
        const result = fragment.build(
          scopeOf(bound, 'fragment', ctx, options, { uv: input.uv, box: input.box }, read, media),
        )
        return fromShader(result, srgb)
      }),
    )
  }
  return close
}

const isColorParam = (v: unknown): boolean =>
  (v as { '~kind'?: string } | null)?.['~kind'] === 'color'

function fits(value: unknown, type: GlslType): boolean {
  if (type === 'float' || type === 'int') return typeof value === 'number'
  if (type === 'bool') return typeof value === 'boolean'
  if (type === 'sampler2D') return typeof value === 'string'
  if ((type === 'vec3' || type === 'vec4') && isColorParam(value)) return true
  return Array.isArray(value) && value.length === VECTOR_SIZES[type]
}

const STRENGTH = { input: 0, hover: 1, visible: 2 } as const

/**
 * Wraps a GLSL stage pair as an effect. Bindings, params and varyings are checked up front and
 * reported together as one `EFFECT_DEFINITION`.
 * @throws {EffectError} `EFFECT_DEFINITION` with every problem found.
 */
/*#__NO_SIDE_EFFECTS__*/
export function glslEffect<S extends ParamSpec, const O extends ParamSpec = Empty>(
  shader: GlslSource<S>,
  options?: GlslEffectOptions<MergeParams<S, O>> & {
    /** Override the shader's pragma defaults. Their types become the param types. */
    readonly params?: O
  } & CheckParams<O>,
): Effect<WidenSpec<MergeParams<S, O>>> {
  const settings = (options ?? {}) as GlslEffectOptions<ParamSpec> & { readonly params?: ParamSpec }
  const stages = shadersOf(shader as GlslSource)
  const { fragment, vertex } = stages
  const shaders = [fragment, vertex].filter((stage): stage is GlslShader => !!stage)
  const problems: string[] = []
  const name = settings.name ?? fragment?.name ?? vertex?.name ?? 'glsl'

  // Every problem is collected and thrown together as one EFFECT_DEFINITION.
  for (const stage of shaders) {
    if (stage['~glsl'] !== 1)
      problems.push(`"${stage.file}" is not a converted GLSL module (~glsl !== 1)`)
  }
  if (!shaders.length) problems.push('needs a fragment or a vertex shader')
  if (vertex && vertex.stage !== 'position')
    problems.push(`vertex "${vertex.file}" has stage ${vertex.stage}`)
  if (fragment && fragment.stage === 'position')
    problems.push(`fragment "${fragment.file}" is a vertex shader`)

  // Glue params override the shader's and must fit the GLSL type.
  const types = new Map<string, GlslType>()
  for (const stage of shaders) {
    for (const info of Object.values(stage.uniforms)) {
      if (info.bind.startsWith('param:')) types.set(info.bind.slice(6), info.type)
    }
  }
  // `uniforms: { uProgress: 'param:reveal' }` makes `reveal` a param of that uniform's type.
  for (const [uniform, bind] of Object.entries(settings.uniforms ?? {})) {
    const info = shaders.map((stage) => stage.uniforms[uniform]).find(Boolean)
    if (info && typeof bind === 'string' && bind.startsWith('param:'))
      types.set(bind.slice(6), info.type)
  }
  const params: Record<string, ParamDefault> = { ...vertex?.params, ...fragment?.params }
  for (const [key, value] of Object.entries(settings.params ?? {})) {
    const type = types.get(key)
    if (type) {
      if (!fits(value, type))
        problems.push(`param "${key}" is ${type} in GLSL; ${JSON.stringify(value)} does not fit`)
    } else {
      const near = similar(key, types.keys())
      const hint = near.length ? ` (did you mean "${near[0]}"?)` : ''
      if (!settings.setup) problems.push(`param "${key}" is not read by the shader${hint}`)
      else if (hint && DEV)
        console.warn(`[diorama/glsl] "${name}": param "${key}" is only for JS${hint}`)
    }
    params[key] = value
  }

  // Binding overrides must name a uniform, and a known input or param.
  for (const [uniform, bind] of Object.entries(settings.uniforms ?? {})) {
    if (!shaders.some((stage) => stage.uniforms[uniform])) {
      problems.push(
        `uniforms.${uniform}: no such uniform${similar(
          uniform,
          shaders.flatMap((stage) => Object.keys(stage.uniforms)),
        )
          .map((suggestion) => ` (did you mean "${suggestion}"?)`)
          .join('')}`,
      )
      continue
    }
    if (typeof bind !== 'string') continue
    if (bind.startsWith('input:') && !isInput(bind.slice(6)))
      problems.push(`uniforms.${uniform}: unknown input "${bind.slice(6)}"`)
    if (bind.startsWith('param:') && !(bind.slice(6) in params))
      problems.push(`uniforms.${uniform}: unknown param "${bind.slice(6)}"`)
  }
  // Textures need a source and prototypes a body.
  for (const stage of shaders) {
    for (const [uniform, info] of Object.entries(stage.uniforms)) {
      const bind =
        typeof settings.uniforms?.[uniform] === 'string'
          ? (settings.uniforms[uniform] as string)
          : info.bind
      if (
        bind.startsWith('texture:') &&
        !settings.textures?.[bind.slice(8)] &&
        !stage.textures[bind.slice(8)]
      ) {
        problems.push(
          `texture "${uniform}" has no source: pass textures.${uniform} or add // @texture ./file`,
        )
      }
    }
    for (const fn of stage.externals) {
      if (typeof settings.functions?.[fn] !== 'function')
        problems.push(`prototype "${fn}" needs functions.${fn}`)
    }
  }
  for (const key of Object.keys(settings.textures ?? {})) {
    const info = shaders.map((stage) => stage.uniforms[key]).find(Boolean)
    if (info?.type !== 'sampler2D') problems.push(`textures.${key}: no such sampler`)
  }
  // A `textures` entry turns a per-element image param into a fixed texture.
  const uniforms: Record<string, Binding | ((ctx: EffectContext<ParamSpec>) => Node)> = {
    ...settings.uniforms,
  }
  for (const key of Object.keys(settings.textures ?? {})) {
    for (const stage of shaders) {
      const bind = stage.uniforms[key]?.bind
      if (bind?.startsWith('param:') && !(key in uniforms)) {
        uniforms[key] = `texture:${key}`
        if (!(bind.slice(6) in (settings.params ?? {}))) delete params[bind.slice(6)]
      }
    }
  }

  // Varyings the fragment reads must come from the vertex shader.
  for (const varying of Object.keys(fragment?.varyings ?? {})) {
    if (!vertex?.writes.includes(varying)) {
      problems.push(
        `GLSL_VARYING: "${varying}" is not written by a vertex shader. Diorama gives only uv; vNormal and vPosition need a vertex shader`,
      )
    }
  }
  if (problems.length)
    throw new EffectError('EFFECT_DEFINITION', problems.join('; '), { effect: name })

  // The definition: animate is the strongest of the stages, pragmas first.
  const pragmas = shaders.filter((stage) => stage.animateFromPragma)
  const strongest = (from: readonly GlslShader[]): GlslShader['animate'] =>
    from.reduce<GlslShader['animate']>(
      (best, stage) => (STRENGTH[stage.animate] > STRENGTH[best] ? stage.animate : best),
      'input',
    )
  const animate = settings.animate ?? (pragmas.length ? strongest(pragmas) : strongest(shaders))
  const media =
    shaders.some((stage) => Object.values(stage.uniforms).some((info) => info.bind === 'media')) ||
    (!fragment && !!vertex)
  const apply = { ...settings, uniforms }
  // A new definition field is a type error here until glslEffect infers or passes it.
  // `when`, `reducedMotion` and `presence` may come from file pragmas, the fragment's first.
  const pragma = <K extends 'when' | 'reducedMotion' | 'presence'>(key: K): GlslShader[K] =>
    fragment?.[key] ?? vertex?.[key]
  const passed = {
    rebuild: settings.rebuild,
    reducedMotion: settings.reducedMotion ?? pragma('reducedMotion'),
    when: settings.when ?? pragma('when'),
    on: settings.on,
    presence: settings.presence ?? pragma('presence'),
    quality: settings.quality,
    burst: settings.burst,
  } satisfies Record<Exclude<keyof EffectDefinition<ParamSpec>, Inferred>, unknown>
  return defineEffect({
    ...passed,
    name,
    params,
    media,
    animate,
    bleed: settings.bleed ?? Math.max(0, ...shaders.map((stage) => stage.bleed)),
    async setup(ctx: Context) {
      ctx.onDispose(await mount(ctx, stages, apply, fragment?.segments ?? 1))
      return settings.setup?.(ctx)
    },
  } as EffectDefinition<ParamSpec>) as unknown as Effect<WidenSpec<MergeParams<S, O>>>
}

/** Adds a shader to the surface from a custom effect's setup. Call the result to remove it. */
export function applyShader<P extends ParamSpec>(
  ctx: EffectContext<P>,
  shader: GlslSource,
  options: ApplyOptions = {},
): Off {
  let off: Off | undefined
  let cancelled = false
  const stages = shadersOf(shader)
  const c = ctx as unknown as Context
  mount(c, stages, { ...options, mode: 'surface' }, 1).then(
    (o) => {
      if (cancelled) o()
      else {
        off = o
        ctx.onDispose(o)
      }
      ctx.invalidate()
    },
    (error: unknown) => report(c, error, 'applyShader'),
  )
  return () => {
    cancelled = true
    off?.()
  }
}

/**
 * The fragment shader as a vec4 node for a custom material. The element's image is
 * `texture(map, coverUV(uv))` times the box mask.
 * @throws {EffectError} `EFFECT_SETUP` when a shader uniform is bound to a missing param.
 */
export function shaderNode<P extends ParamSpec>(
  ctx: EffectContext<P>,
  shader: GlslShader,
  options: ApplyOptions & { readonly uv?: Node<'vec2'> } = {},
): Node<'vec4'> {
  const context = ctx as unknown as Context
  const at = options.uv ?? (uvNode() as Node<'vec2'>)
  const colorSpace = options.colorSpace ?? shader.colorSpace
  const srgb = colorSpace === 'srgb'
  const nodes: Record<string, Node | SamplerLike> = {}
  for (const [name, info] of Object.entries(shader.uniforms)) {
    const override = options.uniforms?.[name]
    if (typeof override === 'function') {
      nodes[name] = override(context)
      continue
    }
    const bind = override ?? info.bind
    if (bind === 'media') {
      nodes[name] = {
        sample: (coordinate) => {
          const at = edge(coordinate)
          const sampled = texture(context.map, context.coverUV(at)) as unknown as Node<'vec4'>
          const rgba = vec4(sampled.rgb, sampled.a.mul(context.mask(at))) as Node<'vec4'>
          return intoShader(rgba, srgb)
        },
      }
      continue
    }
    nodes[name] = bindingNode(context, shader, options, info.type, bind, (source) =>
      lateTexture(context, source, colorSpace),
    )
  }
  const bound: Bound = { fragment: nodes, vertex: {}, varyings: {} }
  const result = shader.build(scopeOf(bound, 'fragment', context, options, { uv: at, box: at }))
  if (shader.stage === 'uv') {
    const media = nodes[mediaOf(shader) ?? ''] as SamplerLike | undefined
    if (!media) return vec4(0) as Node<'vec4'>
    const color = media.sample(result as Node<'vec2'>)
    return fromShader(color, srgb)
  }
  return fromShader(result, srgb)
}
