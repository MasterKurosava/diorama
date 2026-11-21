// The focus ring of an element the copy hides: `filter: opacity(0)` hides the site's outline with
// the element, so the effect draws it, in the site's own focus style, while the element matches
// :focus-visible. Shapes are signed distances in px, drawn in `surface.color` or a placed object.
import type { EffectContext } from '@dioramajs/effects'
import { radii, roundedBox } from '@dioramajs/effects/kit'
import { cssColor } from '@dioramajs/render'
import { clamp, length, positionLocal, uniform, uv, vec3, vec4 } from 'three/tsl'
import {
  Color,
  Mesh,
  MeshBasicNodeMaterial,
  type Node,
  PlaneGeometry,
  type UniformNode,
  type Vector2,
} from 'three/webgpu'

/** The ring a focused element gets: colour as '#rrggbb', width and offset in px. */
export interface RingStyle {
  readonly color: string
  readonly width: number
  readonly offset: number
}

/** The focus ring of an element, as uniforms. */
export interface FocusRing {
  /** 1 while the element matches :focus-visible, else 0. */
  readonly on: UniformNode<'float'>
  readonly color: UniformNode<'color'>
  /** px. */
  readonly width: UniformNode<'float'>
  /** Gap between the shape and the ring, px. */
  readonly offset: UniformNode<'float'>
  /** Ring alpha at signed distance `edge` px from the shape's edge (negative inside), times `on`. */
  alpha(edge: Node<'float'>): Node<'float'>
}

const px = (value: string): number => Number.parseFloat(value) || 0

/**
 * The site's focus style of `element` as computed now: its outline colour, width and offset. With
 * `outline-style: none` 2 px of `Highlight`; the browser's `auto` ring is at least 2 px.
 */
export function ringStyle(element: Element): RingStyle {
  const style = getComputedStyle(element)
  const kind = style.outlineStyle
  if (!kind || kind === 'none') {
    return { color: cssColor('Highlight') ?? '#1a73e8', width: 2, offset: 0 }
  }
  const width = px(style.outlineWidth)
  return {
    color: cssColor(style.outlineColor) ?? '#1a73e8',
    width: kind === 'auto' ? Math.max(width, 2) : width,
    offset: px(style.outlineOffset),
  }
}

/** :focus-visible, or :focus where the engine does not know it. */
function visible(element: Element): boolean {
  try {
    return element.matches(':focus-visible')
  } catch {
    return element.matches(':focus')
  }
}

/**
 * Tracks whether `element` shows a focus ring and in what style, for as long as the phase lives.
 * Each change requests a frame.
 */
export function focusRing(
  ctx: Pick<EffectContext, 'signal' | 'invalidate'>,
  element: Element,
): FocusRing {
  const on = uniform(0)
  const color = uniform(new Color())
  const width = uniform(2)
  const offset = uniform(0)
  const check = (): void => {
    const shown = visible(element) ? 1 : 0
    if (shown) {
      const style = ringStyle(element)
      color.value.setStyle(style.color)
      width.value = style.width
      offset.value = style.offset
    }
    if (on.value === shown) return
    on.value = shown
    ctx.invalidate()
  }
  // A key press can turn a clicked element's focus visible without a focus event.
  for (const type of ['focus', 'blur', 'keydown', 'keyup']) {
    element.addEventListener(type, check, { signal: ctx.signal })
  }
  check()
  return {
    on: on as unknown as UniformNode<'float'>,
    color: color as unknown as UniformNode<'color'>,
    width: width as unknown as UniformNode<'float'>,
    offset: offset as unknown as UniformNode<'float'>,
    alpha(edge) {
      // A 1 px antialiased band from `offset` to `offset + width` outside the edge.
      const inner = clamp(edge.sub(offset).add(0.5), 0, 1)
      const outer = clamp(offset.add(width).sub(edge).add(0.5), 0, 1)
      return inner.mul(outer).mul(on) as unknown as Node<'float'>
    },
  }
}

/** Signed distance in px from a circle of `radius` around the origin of `point`. */
export function circle(point: Node<'vec2'>, radius: Node<'float'> | number): Node<'float'> {
  return length(point).sub(radius) as unknown as Node<'float'>
}

/** The focus ring of a box, as a mesh for `ctx.place`. */
export interface BoxRing {
  readonly ring: FocusRing
  readonly mesh: Mesh
  /** Shows the mesh while the ring is on and takes the element's corner radius. Call in update. */
  update(): void
}

/**
 * The focus ring of `element` around the element's box, rounded like its border, drawn after the
 * copy: `ctx.place(boxRing(ctx, el).mesh)`. For an element the copy hides whole.
 */
export function boxRing(
  ctx: Pick<EffectContext, 'signal' | 'invalidate'> & {
    readonly u: { readonly size: UniformNode<'vec2'>; readonly opacity: UniformNode<'float'> }
  },
  element: Element,
): BoxRing {
  const ring = focusRing(ctx, element)
  const corner = uniform(0)
  const size = ctx.u.size as unknown as Node<'vec2'>
  const material = new MeshBasicNodeMaterial({
    transparent: true,
    depthTest: false,
    depthWrite: false,
  })
  // The quad grows past the box by the ring and its offset.
  const outer = size.add(ring.offset.add(ring.width).add(2).mul(2))
  material.positionNode = positionLocal.mul(vec3(outer.div(size), 1))
  const edge = roundedBox(
    uv().sub(0.5).mul(outer),
    size.mul(0.5),
    corner as unknown as Node<'float'>,
  )
  material.colorNode = vec4(ring.color, ring.alpha(edge).mul(ctx.u.opacity))
  const mesh = new Mesh(new PlaneGeometry(1, 1), material)
  mesh.frustumCulled = false
  mesh.visible = false
  mesh.renderOrder = 2
  return {
    ring,
    mesh,
    update() {
      mesh.visible = ring.on.value === 1
      if (mesh.visible) {
        const { x, y } = ctx.u.size.value as Vector2
        corner.value = radii(element, x, y)[0]
      }
    },
  }
}
