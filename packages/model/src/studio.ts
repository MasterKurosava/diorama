// Shared parts of the product effects: the dissolve of a page transition, the tone mapping of lit
// materials, a soft shadow on the page, the pointer over the element, and reading pictures.
import type { InputUniforms } from '@dioramajs/effects'
import { roundedBox } from '@dioramajs/effects/kit'
import {
  float,
  hash,
  neutralToneMapping,
  output,
  screenCoordinate,
  smoothstep,
  uint,
  uniform,
  uv,
  vec2,
  vec3,
  vec4,
} from 'three/tsl'
import {
  Color,
  Mesh,
  MeshBasicNodeMaterial,
  type Node,
  PlaneGeometry,
  SRGBColorSpace,
  type Texture,
  Vector4,
} from 'three/webgpu'

/** An edge of a picture. */
export type Edge = 'left' | 'right' | 'top' | 'bottom'
type F = Node<'float'>
type V4 = Node<'vec4'>

/** Opaque materials leave by dithering their pixels away with presence and CSS opacity. */
export function dissolve(u: InputUniforms): Node<'bool'> {
  const pixel = uint(screenCoordinate.x).add(uint(screenCoordinate.y).mul(8192))
  // Below 1, so full presence keeps every pixel.
  const threshold = hash(pixel).mul(0.999)
  return threshold.lessThan(u.presence.mul(u.opacity)) as unknown as Node<'bool'>
}

/** Tone mapping of a lit material: the copies of the page stay untouched. */
export function toned(): Node {
  return vec4(neutralToneMapping(output.rgb, float(1)) as Node<'vec3'>, output.a)
}

/** A picture seen at a grazing angle stays sharp: anisotropic filtering, up to 8 samples. */
export function sharpen(map: Texture, renderer: unknown): void {
  const supported = (renderer as { getMaxAnisotropy?(): number }).getMaxAnisotropy?.() ?? 1
  const want = Math.min(8, supported)
  if (map.anisotropy >= want) return
  map.anisotropy = want
  map.needsUpdate = true
}

/** A soft shadow on the page: a tight contact shade and a wide ambient one. */
export interface Shadow {
  readonly mesh: Mesh
  /**
   * Box `width` × `height` px with `corner`, centred at `x`, `y` (px, y up), `blur` px wide,
   * `density` 0..1.
   */
  set(
    width: number,
    height: number,
    corner: number,
    x: number,
    y: number,
    blur: number,
    density: number,
  ): void
}

export function shadow(u: InputUniforms): Shadow {
  // Width, height, corner radius and blur, px.
  const shape = uniform(new Vector4(1, 1, 0, 1))
  // Drop of the ambient shade, px, and density.
  const look = uniform(new Vector4(0, 0, 0, 0))
  const material = new MeshBasicNodeMaterial({
    transparent: true,
    depthTest: false,
    depthWrite: false,
  })
  const box = shape as unknown as V4
  const corner = box.z as F
  const blur = box.w
  const drop = (look as unknown as V4).x
  const density = (look as unknown as V4).y
  // The plane is the box plus two blurs on every side.
  const full = box.xy.add(blur.mul(4))
  const px = uv().sub(0.5).mul(full)
  const half = box.xy.mul(0.5)
  const contact = smoothstep(
    blur.mul(0.3),
    blur.mul(-0.3),
    roundedBox(px.sub(vec2(0, drop.mul(0.3))), half.mul(0.97), corner),
  )
  const ambient = smoothstep(blur, blur.negate(), roundedBox(px.sub(vec2(0, drop)), half, corner))
  material.colorNode = vec3(0.02, 0.02, 0.035)
  material.opacityNode = contact
    .mul(0.28)
    .add(ambient.mul(0.42))
    .mul(density, u.presence, u.opacity)
  const mesh = new Mesh(new PlaneGeometry(1, 1), material)
  mesh.renderOrder = -1
  mesh.frustumCulled = false
  return {
    mesh,
    set(width, height, corner, x, y, blur, density) {
      const soft = Math.max(1, blur)
      ;(shape.value as Vector4).set(width, height, Math.min(corner, width / 2, height / 2), soft)
      // The ambient shade falls further down than the contact one.
      ;(look.value as Vector4).set(-soft * 0.5, density, 0, 0)
      mesh.scale.set(width + 4 * soft, height + 4 * soft, 1)
      mesh.position.set(x, y, 0)
      mesh.visible = density > 0
    },
  }
}

/** The pointer over an element from its own events, so moves elsewhere draw nothing. */
export class Pointer {
  /** Client px of a mouse or pen over the element. */
  at: { x: number; y: number } | undefined
  /** Keyboard focus on the element or the link around it. */
  focused = false

  constructor(element: Element, signal: AbortSignal, wake: () => void, focus = false) {
    const listen = <K extends keyof HTMLElementEventMap>(
      target: Element,
      type: K,
      fn: (e: HTMLElementEventMap[K]) => void,
    ): void => target.addEventListener(type, fn as EventListener, { signal })
    const at = (e: PointerEvent): void => {
      if (e.pointerType === 'touch') return
      this.at = { x: e.clientX, y: e.clientY }
      wake()
    }
    const off = (): void => {
      if (!this.at) return
      this.at = undefined
      wake()
    }
    listen(element, 'pointerenter', at)
    listen(element, 'pointermove', at)
    listen(element, 'pointerleave', off)
    listen(element, 'pointercancel', off)
    if (!focus) return
    const host = element.closest('a[href], area[href], button, [tabindex]')
    if (!host) return
    const check = (): void => {
      let shown = false
      try {
        shown = host.matches(':focus-visible')
      } catch {
        shown = host.matches(':focus')
      }
      if (shown === this.focused) return
      this.focused = shown
      wake()
    }
    for (const type of ['focus', 'blur', 'keyup'] as const) listen(host, type, check)
  }

  /** -1..1 across the box, y up; undefined while the pointer is elsewhere. */
  aim(box: {
    readonly x: number
    readonly y: number
    readonly width: number
    readonly height: number
  }): [number, number] | undefined {
    if (!this.at || !box.width || !box.height) return undefined
    const x = ((this.at.x - box.x) / box.width) * 2 - 1
    const y = 1 - ((this.at.y - box.y) / box.height) * 2
    return [Math.max(-1, Math.min(1, x)), Math.max(-1, Math.min(1, y))]
  }
}

/** A colour or a URL of a picture: a URL has a dot or a slash and is no CSS function. */
export const isUrl = (value: string): boolean =>
  /[/.]/.test(value) && !/^\s*(#|[a-z-]+\()/i.test(value)

const EDGE_SAMPLES = 16

/** The average colour of a thin strip along one edge of a picture. */
export function edgeColor(image: unknown, edge: Edge): Color | undefined {
  try {
    const source = image as {
      width?: number
      height?: number
      naturalWidth?: number
      naturalHeight?: number
    }
    const w = source.naturalWidth || source.width || 0
    const h = source.naturalHeight || source.height || 0
    if (!w || !h) return undefined
    // The strip, 3% of the picture deep, is scaled down to a line of 16 px.
    const across = edge === 'left' || edge === 'right'
    const [lineW, lineH] = across ? [1, EDGE_SAMPLES] : [EDGE_SAMPLES, 1]
    const canvas =
      typeof OffscreenCanvas === 'function'
        ? new OffscreenCanvas(lineW, lineH)
        : Object.assign(document.createElement('canvas'), { width: lineW, height: lineH })
    const context = canvas.getContext('2d') as CanvasRenderingContext2D | null
    if (!context) return undefined
    const stripW = across ? Math.max(1, w * 0.03) : w
    const stripH = across ? h : Math.max(1, h * 0.03)
    const stripX = edge === 'right' ? w - stripW : 0
    const stripY = edge === 'bottom' ? h - stripH : 0
    context.drawImage(
      image as CanvasImageSource,
      stripX,
      stripY,
      stripW,
      stripH,
      0,
      0,
      lineW,
      lineH,
    )
    const data = context.getImageData(0, 0, lineW, lineH)?.data
    if (!data || data.length < EDGE_SAMPLES * 4) return undefined
    let red = 0
    let green = 0
    let blue = 0
    for (let i = 0; i < EDGE_SAMPLES * 4; i += 4) {
      red += data[i] as number
      green += data[i + 1] as number
      blue += data[i + 2] as number
    }
    const total = EDGE_SAMPLES * 255
    return new Color().setRGB(red / total, green / total, blue / total, SRGBColorSpace)
  } catch {
    return undefined
  }
}
