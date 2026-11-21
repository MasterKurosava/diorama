// The runtime side of an instance (`Inst`) and its setup runs (`Phase`), and the `ctx` object a
// phase gives its setup: params, input uniforms and the services of the runtime.
import type { Anchor, AppScope, Off } from '@dioramajs/core'
import type { RenderApi } from '@dioramajs/render'
import { cssColor } from '@dioramajs/render'
import { uniform } from 'three/tsl'
import {
  Color,
  Group,
  type Object3D,
  type Texture,
  type UniformNode,
  Vector2,
  Vector3,
  Vector4,
} from 'three/webgpu'
import { INPUTS } from '../effect'
import { EffectError } from '../errors'
import { rebuilds } from '../params'
import type { InstanceRecord } from '../ports'
import type {
  AnyParamValue,
  Effect,
  EffectApp,
  EffectContext,
  EffectDefinition,
  EffectHandle,
  EffectUpdate,
  EffectUse,
  Fit,
  FitOptions,
  Layer,
  ModelOptions,
  ParamDefault,
  ParamSpec,
  PlaceOptions,
  PoseTarget,
  QualityTier,
  Surface,
  TextureOptions,
} from '../types'
import type { FitImpl } from './fit'
import type { LayerImpl } from './layer'
import { readsMedia } from './media'

type UniformValue = number | Color | Vector2 | Vector3 | Vector4
type ParamNode = UniformNode<'float'>

/** The runtime services behind a phase's `ctx`. */
export interface PhaseHost {
  readonly render: RenderApi
  /** Shared `u.velocity`. Taking it makes the phase read scroll velocity every frame. */
  velocity(phase: Phase): UniformNode<'float'>
  readonly motion: UniformNode<'float'>
  /** Effects root where viewport groups live. */
  readonly root: Group
  invalidate(): void
  surface(phase: Phase): Surface
  media(phase: Phase): void
  place(phase: Phase, object: Object3D, options?: PlaceOptions): void
  layers(phase: Phase, selector: string): readonly Layer[]
  pose(phase: Phase, layer: Layer, target: PoseTarget, weight: number): void
  attach(phase: Phase, target: string | Element, use: Effect | EffectUse): EffectHandle
  texture(phase: Phase, url: string, options?: TextureOptions): Promise<Texture>
  model(phase: Phase, url: string, options?: ModelOptions): Promise<Object3D>
  fit(phase: Phase, texture: Texture, options?: FitOptions): Fit
  showDom(phase: Phase, show: boolean): void
  compile(phase: Phase, object: Object3D): Promise<void>
  section(phase: Phase): Anchor
  raise(phase: Phase): Off
  /** The quality tier now. */
  tier(): QualityTier
  /** Updates are running, so a read of `ctx.quality` is a live one. */
  updating(): boolean
}

const TIERS: readonly QualityTier[] = ['low', 'medium', 'high']
export const rank = (tier: QualityTier | undefined): number => TIERS.indexOf(tier ?? 'low')

/** The value at a tier: numbers above the effect's cap for it are lowered. */
export function capped(
  def: EffectDefinition<ParamSpec>,
  tier: QualityTier,
  key: string,
  value: AnyParamValue | undefined,
): AnyParamValue | undefined {
  const cap = tier === 'high' ? undefined : (def.quality?.[tier] as Record<string, number>)?.[key]
  return typeof value === 'number' && cap !== undefined && value > cap ? cap : value
}

/** Why a definition's `quality` is invalid, or undefined. Checked once per definition. */
export function qualityProblem(def: EffectDefinition<ParamSpec>): string | undefined {
  const quality = def.quality as Record<string, unknown> | undefined
  if (quality === undefined) return undefined
  if (typeof quality !== 'object' || quality === null) return 'quality must be an object'
  for (const [key, caps] of Object.entries(quality)) {
    if (key === 'min') {
      if (!TIERS.includes(caps as QualityTier)) return `quality.min "${String(caps)}" is not a tier`
      continue
    }
    if (key !== 'low' && key !== 'medium') return `quality.${key} is not a tier with caps`
    for (const [param, cap] of Object.entries(caps as object)) {
      if (typeof def.params?.[param] !== 'number') {
        return `quality.${key}.${param} caps a param that is not a number`
      }
      if (!Number.isFinite(cap)) return `quality.${key}.${param} must be a finite number`
    }
  }
  return undefined
}

/** A uniform for a live param. Strings and choices get none. */
function paramUniform(
  spec: ParamDefault,
  value: AnyParamValue,
  element: Element,
): ParamNode | undefined {
  if (rebuilds(spec)) return undefined
  // The node type follows the value at runtime; the cast only picks one of uniform()'s overloads.
  const node = uniform(emptyValue(spec) as number) as unknown as ParamNode
  setUniform(node, value, element)
  return node
}

/** A colour value that reads the element's style, which may change without a write. */
export const styled = (value: AnyParamValue): value is string =>
  typeof value === 'string' && /var\(|currentcolor/i.test(value)

function emptyValue(spec: ParamDefault): UniformValue {
  if (typeof spec === 'number' || typeof spec === 'boolean') return 0
  if (!Array.isArray(spec)) return new Color()
  if (spec.length === 2) return new Vector2()
  return spec.length === 3 ? new Vector3() : new Vector4()
}

/**
 * Writes a param value into its uniform: numbers and booleans, colours, tuples. A colour's
 * `var()` and `currentColor` are read from `element`.
 */
export function setUniform(node: ParamNode, value: AnyParamValue, element?: Element): void {
  const current = node.value as UniformValue
  if (typeof value === 'number' || typeof value === 'boolean') node.value = Number(value)
  // three parses only some of CSS: an unreadable colour keeps the previous one.
  else if (typeof value === 'string') {
    const parsed = cssColor(value, element)
    if (parsed) (current as Color).setStyle(parsed)
  } else (current as Vector4).fromArray(value as number[])
}

/**
 * Marks a clock read on the phase. A read after activation (a `Fn` body runs when the material
 * compiles, after the frame decision) requests a frame so the new policy applies.
 */
function markClock(phase: Phase, name: string, host: PhaseHost): void {
  const field = name === 'time' ? 'clock' : name === 'hoverTime' ? 'hoverClock' : undefined
  if (field && !phase[field]) {
    phase[field] = true
    if (phase.state === 'active') host.invalidate()
  }
}

/** One run of `setup`. Everything it created lives and dies together. */
export class Phase {
  readonly inst: Inst
  readonly def: EffectDefinition<ParamSpec>
  readonly scope: AppScope
  /** Values at setup. Rebuild params read from here, live ones from the record. */
  readonly values: Readonly<Record<string, AnyParamValue>>
  readonly uniforms: Map<string, ParamNode> = new Map()
  /** Colour params whose value reads the element's style, by name: read again every frame. */
  readonly styled: Map<string, string> = new Map()
  readonly ctx: EffectContext
  state: 'setup' | 'ready' | 'active' | 'closed' = 'setup'
  update: EffectUpdate | undefined
  /** Read `u.time` or `input.time`. */
  clock = false
  /** Read `u.hoverTime` or `input.hoverTime`. */
  hoverClock = false
  /** The update has returned a boolean: it says itself when it stops, so it may be a burst. */
  answers = false
  /** The last update returned true: it asks for the next frame, and a burst flies on. */
  more = false
  /** Largest `surface.segments()` request. */
  segments = 0
  /** `ctx.showDom(true)`: the DOM shows the picture, this phase's copy does not count. */
  dom = false
  /** Read `ctx.quality` outside update, so a tier change rebuilds it. */
  tiered = false
  /** `ctx.section()` and the layer anchor and version it was looked up at. */
  section: { readonly anchor: Anchor; readonly by: Anchor; readonly version: number } | undefined
  /** Loop time of the last time frame under `animate: { fps }`. */
  stamp: number = Number.NEGATIVE_INFINITY
  /** Ready of the environment lease, waited for before activation. */
  lit: Promise<void> | undefined
  /** Slots made by `ctx.fit`, reframed in layout. */
  readonly fits: FitImpl[] = []
  /** `ctx.overlay`: like `viewport`, drawn after every copy without depth. */
  overlay: Group | undefined
  /** `ctx.viewport`: pinned to the viewport under the effects root, not to the box. */
  viewport: Group | undefined
  surface: Surface | undefined
  /** The object `place(object, { replace: true })` stands in for the element with. */
  replace: Object3D | undefined
  /** Groups under the layer that hold placed objects, one per `fit`. */
  readonly groups: Group[] = []
  readonly placed: { readonly object: Object3D; readonly dispose: boolean }[] = []
  /** Sources and leases taken by `ctx.attach` and `layers()`. */
  readonly offs: Off[] = []
  /** Its groups are visible: set on activation and when its instance parks or returns. */
  shown = false
  /** Settles the wait for activation: nothing once active, else the error or ABORTED. */
  done: ((result?: unknown) => void) | undefined

  constructor(
    inst: Inst,
    def: EffectDefinition<ParamSpec>,
    values: Readonly<Record<string, AnyParamValue>>,
    scope: AppScope,
    host: PhaseHost,
  ) {
    this.inst = inst
    this.def = def
    this.values = values
    this.scope = scope
    for (const [key, spec] of Object.entries(def.params ?? {})) {
      const value = values[key] as AnyParamValue
      const node = paramUniform(spec, value, inst.rec.element)
      if (!node) continue
      this.uniforms.set(key, node)
      if (styled(value)) this.styled.set(key, value)
    }
    this.ctx = context(this, host)
  }

  /** Writes a live param into its uniform and follows whether it reads the element's style. */
  write(name: string, value: AnyParamValue): void {
    const node = this.uniforms.get(name)
    if (!node) return
    setUniform(node, value, this.inst.rec.element)
    if (styled(value)) this.styled.set(name, value)
    else this.styled.delete(name)
  }

  /** Reads `var()` and `currentColor` of colour params again, for a variable that changed. */
  restyle(): void {
    for (const [name, value] of this.styled) {
      setUniform(this.uniforms.get(name) as ParamNode, value, this.inst.rec.element)
    }
  }

  /** A group under the layer for one `fit`, hidden until the phase is shown. */
  group(fit: 'box' | 'contain' | 'none'): Group {
    const layer = this.inst.layer
    const parent = fit === 'box' ? layer.box : fit === 'contain' ? layer.contain : layer.root
    let group = this.groups.find((candidate) => candidate.parent === parent)
    if (!group) {
      group = new Group()
      group.visible = this.shown
      parent.add(group)
      this.groups.push(group)
    }
    return group
  }

  show(shown: boolean): void {
    this.shown = shown
    for (const group of this.groups) group.visible = shown
  }
}

/** Runtime side of an instance record: its layer and its current and next phase. */
export class Inst {
  /** The light part's record. */
  readonly rec: InstanceRecord
  readonly layer: LayerImpl
  current: Phase | undefined
  /** A setup in progress or waiting for its material (mount, rebuild). */
  next: Phase | undefined
  parked = false
  /** A rebuild waits for the next frame where the layer is visible. */
  rebuild = false
  live = true
  /** Latest setup call. A new one waits for it, so a pair never runs two setups. */
  settled: Promise<unknown> = Promise.resolve()
  /** Latest rebuild request. Older ones waiting for `settled` give up. */
  ticket = 0
  /** Rebuild start times of the last second, for the dev warning about tweened rebuilds. */
  rebuilds: number[] = []

  constructor(record: InstanceRecord, layer: LayerImpl) {
    this.rec = record
    this.layer = layer
  }
}

/** `ctx` of one phase. Services throw once the phase is closed. */
function context(phase: Phase, host: PhaseHost): EffectContext {
  const { inst, def, scope } = phase
  const { rec: record, layer } = inst
  const guard = (): void => {
    if (phase.state !== 'closed') return
    throw new EffectError('EFFECT_SETUP', 'instance disposed', {
      effect: record.name,
      element: record.element,
    })
  }
  /** A hidden group under the effects root, for `viewport` and `overlay`. */
  const group = (): Group => {
    const created = new Group()
    created.visible = false
    host.root.add(created)
    return created
  }
  return Object.freeze({
    name: record.name,
    element: record.element,
    params: liveParams(phase, host),
    set: (values) => {
      guard()
      record.facade.set(values)
    },
    u: inputUniforms(phase, host),
    input: layer.input,
    layer,
    render: host.render,
    app: scope as unknown as EffectApp,
    signal: scope.abortSignal,
    onDispose: (cleanup) => scope.onDispose(cleanup),
    invalidate: () => {
      if (layer.visible) host.invalidate()
    },
    get surface() {
      guard()
      phase.surface ??= host.surface(phase)
      return phase.surface
    },
    get map() {
      guard()
      if (!readsMedia(def, record.element)) {
        const message = `"${record.name}" reads ctx.map: declare media: true`
        throw new EffectError('EFFECT_TARGET', message, {
          effect: record.name,
          element: record.element,
        })
      }
      host.media(phase)
      return layer.media?.texture as never
    },
    coverUV: (at) => layer.coverUV(at),
    mask: (at) => layer.mask(at),
    place: (object, options) => {
      guard()
      host.place(phase, object, options)
      return object
    },
    get viewport() {
      guard()
      phase.viewport ??= group()
      return phase.viewport
    },
    get overlay() {
      guard()
      phase.overlay ??= group()
      return phase.overlay
    },
    get quality() {
      if (!host.updating()) phase.tiered = true
      return host.tier()
    },
    showDom: (show) => {
      guard()
      host.showDom(phase, show)
    },
    section: () => {
      guard()
      return host.section(phase)
    },
    raise: () => {
      guard()
      return host.raise(phase)
    },
    compile: (object) => {
      guard()
      return host.compile(phase, object)
    },
    texture: (url, options) => {
      guard()
      return host.texture(phase, url, options)
    },
    model: (url, options) => {
      guard()
      return host.model(phase, url, options)
    },
    fit: (texture, options) => {
      guard()
      return host.fit(phase, texture, options)
    },
    layers: (selector) => {
      guard()
      return host.layers(phase, selector)
    },
    pose: (target, pose, weight) => {
      guard()
      host.pose(phase, target, pose, weight)
    },
    attach: (target, use) => {
      guard()
      return host.attach(phase, target, use as unknown as EffectUse) as never
    },
  } satisfies EffectContext)
}

/**
 * `ctx.params`. Rebuild params read the values the phase was set up with, live ones the record's
 * current values, capped for the quality tier.
 */
function liveParams(phase: Phase, host: PhaseHost): EffectContext['params'] {
  const { def } = phase
  const record = phase.inst.rec
  const params = {}
  for (const [key, spec] of Object.entries(def.params ?? {})) {
    const snapshot = rebuilds(spec) || def.rebuild?.includes(key)
    Object.defineProperty(params, key, {
      enumerable: true,
      get: () => (snapshot ? phase.values[key] : capped(def, host.tier(), key, record.values[key])),
    })
  }
  return params
}

/** `ctx.u`: the built-in inputs, made on first read, then one uniform per live param. */
function inputUniforms(phase: Phase, host: PhaseHost): EffectContext['u'] {
  const { layer } = phase.inst
  const u = {}
  for (const name of INPUTS) {
    Object.defineProperty(u, name, {
      enumerable: true,
      get: () => {
        if (name === 'velocity') return host.velocity(phase)
        if (name === 'motion') return host.motion
        markClock(phase, name, host)
        return layer.uniform(name)
      },
    })
  }
  for (const [key, node] of phase.uniforms) {
    Object.defineProperty(u, key, { value: node, enumerable: true })
  }
  return u as EffectContext['u']
}
