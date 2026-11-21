// What every cover look shares: the base params, the viewport as nodes, and the full-screen mesh
// that draws the look's colour over everything while the cover is on.
import type { ColorParam, EffectContext, EffectUpdate, ParamSpec } from '@dioramajs/effects'
import { length, max, positionGeometry, screenUV, uniform, vec2, vec4 } from 'three/tsl'
import {
  Color,
  Group,
  Mesh,
  MeshBasicNodeMaterial,
  type Node,
  PlaneGeometry,
  type UniformNode,
  Vector2,
} from 'three/webgpu'

export type F = Node<'float'>
export type V2 = Node<'vec2'>

/** Params every cover has: where it is along the change, and where it starts. */
export type Base = {
  /** 0 the page shows, 1 it is covered, 2 the new page shows. The cover plugin writes it. */
  position: number
  /** Origin across the viewport, 0..1 from the left. */
  x: number
  /** Origin down the viewport, 0..1 from the top. */
  y: number
}

export const BASE: Base = { position: 0, x: 0.5, y: 0.5 }

export const color = (value: string): ColorParam =>
  Object.freeze({ '~kind': 'color', value }) as ColorParam

/** Group renderOrder past every layer key, draw level and overlay: the cover draws last. */
const TOP = 1e12

/** The viewport for a cover's colour graph. */
export interface Screen {
  /** Viewport UV, 0..1 from the top left. */
  readonly uv: V2
  /** Viewport point in CSS px from the top left. */
  readonly px: V2
  /** Viewport size in CSS px. */
  readonly size: UniformNode<'vec2'>
  /** The origin (`x`, `y`) in CSS px. */
  readonly origin: V2
}

/** Distance from `origin` to the farthest viewport corner, CSS px. */
export const farthest = (origin: V2, size: UniformNode<'vec2'>): F =>
  max(
    max(length(origin), length(origin.sub(vec2(size.x, 0)))),
    max(length(origin.sub(vec2(0, size.y))), length(origin.sub(size))),
  ) as F

export function screen<P extends ParamSpec & Base>(ctx: EffectContext<P>): Screen {
  const size = uniform(new Vector2(1, 1)) as unknown as UniformNode<'vec2'>
  const u = ctx.u as unknown as { x: F; y: F }
  return {
    uv: screenUV,
    px: screenUV.mul(size) as V2,
    size,
    origin: vec2(u.x, u.y).mul(size) as V2,
  }
}

/**
 * Draws `color` over the whole viewport, above everything else on the canvas, while `position` is
 * between 0 and 2, with the canvas lifted over the page. Returns the update.
 */
export async function show<P extends ParamSpec & Base>(
  ctx: EffectContext<P>,
  view: Screen,
  color: Node<'vec4'>,
): Promise<EffectUpdate> {
  const material = new MeshBasicNodeMaterial({
    transparent: true,
    depthTest: false,
    depthWrite: false,
  })
  // Straight to clip space: the camera and the overlay's world px don't matter.
  material.vertexNode = vec4(positionGeometry.xy, 0, 1)
  material.colorNode = color
  const mesh = new Mesh(new PlaneGeometry(2, 2), material)
  mesh.frustumCulled = false
  const group = new Group().add(mesh)
  group.renderOrder = TOP
  ctx.overlay.add(group)
  await ctx.compile(group)
  mesh.visible = false
  const { stage } = ctx.app
  const params = ctx.params as unknown as Base
  let lower: (() => void) | undefined
  return () => {
    const on = params.position > 0 && params.position < 2
    mesh.visible = on
    if (on) {
      view.size.value.set(stage.width.peek() || 1, stage.height.peek() || 1)
      // Over sticky headers and chat widgets too, into the top layer.
      lower ??= ctx.raise()
    } else {
      lower?.()
      lower = undefined
    }
  }
}

/** A CSS colour (hex, rgb(), hsl() or a name) in the working colour space, or undefined. */
export function tint(css: string): Color | undefined {
  const value = css.trim()
  const ok =
    typeof CSS !== 'undefined' && typeof CSS.supports === 'function'
      ? CSS.supports('color', value)
      : /^(#|rgba?\(|hsla?\()/i.test(value)
  return value && ok ? new Color().setStyle(value) : undefined
}
