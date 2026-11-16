import type { AppScope, Off } from '@diorama/core'
import type { RenderApi } from '@diorama/render'
import { uniform } from 'three/tsl'
import {
  Color,
  Group,
  type Object3D,
  type UniformNode,
  Vector2,
  Vector3,
  Vector4,
} from 'three/webgpu'
import { INPUTS } from '../define'
import { EffectError } from '../errors'
import type { InstanceRecord } from '../instances'
import { rebuilds } from '../params'
import type {
  AnyParamValue,
  Effect,
  EffectApp,
  EffectContext,
  EffectDefinition,
  EffectHandle,
  EffectUpdate,
  EffectUse,
  Layer,
  ParamDefault,
  ParamSpec,
  PlaceOptions,
  PoseTarget,
  Surface,
} from '../types'
import type { LayerImpl } from './layer'

type Value = number | Color | Vector2 | Vector3 | Vector4
type ParamNode = UniformNode<'float'>

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
}

/** Strings and choices get no uniform. */
function paramUniform(spec: ParamDefault, value: AnyParamValue): ParamNode | undefined {
  if (rebuilds(spec)) return undefined
  const node =
    typeof spec === 'number' || typeof spec === 'boolean'
      ? uniform(0)
      : !Array.isArray(spec)
        ? uniform(new Color())
        : spec.length === 2
          ? uniform(new Vector2())
          : spec.length === 3
            ? uniform(new Vector3())
            : uniform(new Vector4())
  setUniform(node as unknown as ParamNode, value)
  return node as unknown as ParamNode
}

export function setUniform(node: ParamNode, value: AnyParamValue): void {
  const current = node.value as Value
  if (typeof value === 'number' || typeof value === 'boolean') node.value = Number(value)
  // three parses only 3 and 6 hex digits, so strip the alpha of '#rgba' and '#rrggbbaa'.
  else if (typeof value === 'string')
    (current as Color).setStyle(value.replace(/^(#[0-9a-f]{3}|#[0-9a-f]{6})[0-9a-f]{1,2}$/i, '$1'))
  else (current as Vector4).fromArray(value as number[])
}

/**
 * Marks a clock read on the phase. A read after activation (a `Fn` body runs when the material
 * compiles, after the frame decision) requests a frame so the new policy applies.
 */
function clock(phase: Phase, name: string, host: PhaseHost): void {
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
  readonly ctx: EffectContext
  state: 'setup' | 'ready' | 'active' | 'closed' = 'setup'
  update: EffectUpdate | undefined
  /** Read `u.time` or `input.time`. */
  clock = false
  /** Read `u.hoverTime` or `input.hoverTime`. */
  hoverClock = false
  /** Largest `surface.segments()` request. */
  segments = 0
  surface: Surface | undefined
  replace: Object3D | undefined
  readonly groups: Group[] = []
  viewport: Group | undefined
  readonly placed: { readonly object: Object3D; readonly dispose: boolean }[] = []
  /** Sources and leases taken by `ctx.attach` and `layers()`. */
  readonly offs: Off[] = []
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
      const node = paramUniform(spec, values[key] as AnyParamValue)
      if (node) this.uniforms.set(key, node)
    }
    this.ctx = context(this, host)
  }

  /** A group under the layer for one `fit`, hidden until the phase is shown. */
  group(fit: 'box' | 'contain' | 'none'): Group {
    const layer = this.inst.layer
    const parent = fit === 'box' ? layer.box : fit === 'contain' ? layer.contain : layer.root
    let group = this.groups.find((g) => g.parent === parent)
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

  constructor(rec: InstanceRecord, layer: LayerImpl) {
    this.rec = rec
    this.layer = layer
  }
}

function context(phase: Phase, host: PhaseHost): EffectContext {
  const { inst, def, scope } = phase
  const { rec, layer } = inst
  const guard = (): void => {
    if (phase.state === 'closed') {
      throw new EffectError('EFFECT_SETUP', 'instance disposed', {
        effect: rec.name,
        element: rec.element,
      })
    }
  }
  const params = {}
  for (const [key, spec] of Object.entries(def.params ?? {})) {
    const snapshot = rebuilds(spec) || def.rebuild?.includes(key)
    Object.defineProperty(params, key, {
      enumerable: true,
      get: () => (snapshot ? phase.values : rec.values)[key],
    })
  }
  const u = {}
  for (const name of INPUTS) {
    Object.defineProperty(u, name, {
      enumerable: true,
      get: () => {
        if (name === 'velocity') return host.velocity(phase)
        if (name === 'motion') return host.motion
        clock(phase, name, host)
        return layer.uniform(name)
      },
    })
  }
  for (const [key, node] of phase.uniforms) {
    Object.defineProperty(u, key, { value: node, enumerable: true })
  }
  return Object.freeze({
    name: rec.name,
    element: rec.element,
    params,
    u: u as EffectContext['u'],
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
      if (!def.media) {
        throw new EffectError('EFFECT_TARGET', `"${rec.name}" reads ctx.map: declare media: true`, {
          effect: rec.name,
          element: rec.element,
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
      if (!phase.viewport) {
        phase.viewport = new Group()
        phase.viewport.visible = false
        host.root.add(phase.viewport)
      }
      return phase.viewport
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
