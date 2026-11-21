import type { ChoiceParam, Effect, EffectContext } from '@dioramajs/effects'
import { defineEffect, oneOf } from '@dioramajs/effects/effect'
import { follow, toBox } from '@dioramajs/effects/kit'
import { dot, max, smoothstep, texture, vec2, vec4 } from 'three/tsl'
import {
  ClampToEdgeWrapping,
  DataTexture,
  DataUtils,
  HalfFloatType,
  LinearFilter,
  NoColorSpace,
  type Node,
  RGBAFormat,
} from 'three/webgpu'

type Style = 'water' | 'smear' | 'prism'
type Params = {
  style: ChoiceParam<Style>
  strength: number
  radius: number
  duration: number
  swirl: number
  shine: number
  split: number
  resolution: number
}
type V2 = Node<'vec2'>
type V4 = Node<'vec4'>

/** The simulation runs in fixed steps, so a trail looks the same at any frame rate. */
const STEP = 1 / 60
/** Steps one frame may run after a long gap; older time is dropped. */
const CATCH_UP = 6
/** A cell holds at most this share of the radius as displacement. */
const CAP = 0.5
/** How much of the neighbours' average a cell takes per step: the trail spreads like water. */
const SPREAD = 0.2
/** Below a quarter px of displacement the trail counts as settled and the field is cleared. */
const REST = 0.25
/** Refraction depth of the water style: px of offset per unit of surface slope. */
const DEPTH = 56
/** Light from the upper left, y up. */
const LIGHT = [-0.6, 0.8] as const
/** Pointer points kept between two frames. */
const QUEUE = 64

/**
 * A displacement field over the box: `size` × `size` cells, each a vector in box px (y up) that
 * the pointer pushes along its path. Every step it decays, spreads to the neighbours and drifts
 * along itself. Deterministic: the same strokes and steps give the same field.
 */
export class Field {
  readonly x: Float32Array
  readonly y: Float32Array
  /** The next step's x and y, swapped in when it is done. */
  #nx: Float32Array
  #ny: Float32Array
  /** The length of each cell's displacement, for `write`. */
  #m: Float32Array
  /** Largest displacement in the field, px. */
  peak = 0

  constructor(readonly size: number) {
    const cellCount = size * size
    this.x = new Float32Array(cellCount)
    this.y = new Float32Array(cellCount)
    this.#nx = new Float32Array(cellCount)
    this.#ny = new Float32Array(cellCount)
    this.#m = new Float32Array(cellCount)
  }

  /**
   * Pushes the cells within `radius` px of the segment from `a` to `b` (box px, y up, the box
   * `width` × `height`) along the segment, most near it: a pass deposits about its own length.
   */
  stroke(
    ax: number,
    ay: number,
    bx: number,
    by: number,
    radius: number,
    width: number,
    height: number,
  ): void {
    const dx = bx - ax
    const dy = by - ay
    const length2 = dx * dx + dy * dy
    if (length2 < 1e-6 || radius <= 0 || width <= 0 || height <= 0) return
    const cells = this.size
    const cellWidth = width / cells
    const cellHeight = height / cells
    const cap = radius * CAP
    // The cells the stroke can reach: its bounds grown by the radius.
    const colFrom = Math.max(0, Math.floor((Math.min(ax, bx) - radius) / cellWidth))
    const colTo = Math.min(cells - 1, Math.floor((Math.max(ax, bx) + radius) / cellWidth))
    const rowFrom = Math.max(0, Math.floor((Math.min(ay, by) - radius) / cellHeight))
    const rowTo = Math.min(cells - 1, Math.floor((Math.max(ay, by) + radius) / cellHeight))
    for (let j = rowFrom; j <= rowTo; j++) {
      const cellY = (j + 0.5) * cellHeight
      for (let i = colFrom; i <= colTo; i++) {
        const cellX = (i + 0.5) * cellWidth
        // The nearest point of the segment, as a share of it, and the distance to it in radii.
        const along = Math.max(0, Math.min(1, ((cellX - ax) * dx + (cellY - ay) * dy) / length2))
        const distance = Math.hypot(cellX - ax - dx * along, cellY - ay - dy * along) / radius
        if (distance >= 1) continue
        const weight = (1 - distance * distance) ** 2
        const cell = j * cells + i
        let x = (this.x[cell] as number) + dx * weight
        let y = (this.y[cell] as number) + dy * weight
        const length = Math.hypot(x, y)
        if (length > cap) {
          x *= cap / length
          y *= cap / length
        }
        this.x[cell] = x
        this.y[cell] = y
        this.peak = Math.max(this.peak, Math.min(length, cap))
      }
    }
  }

  /**
   * One step of `seconds`: the field fades to 2% over `duration`, spreads to its neighbours and,
   * by `swirl`, drifts along itself with the box `width` × `height` px.
   */
  step(seconds: number, duration: number, swirl: number, width: number, height: number): void {
    const cells = this.size
    const { x, y } = this
    const nextX = this.#nx
    const nextY = this.#ny
    // The fade to 2% over `duration` is exp(-4).
    const fade = Math.exp((-4 * seconds) / Math.max(duration, 1e-3))
    // Drift in cells per px of displacement: a cell moves twice its displacement a second.
    const driftX = (2 * swirl * seconds * cells) / Math.max(width, 1)
    const driftY = (2 * swirl * seconds * cells) / Math.max(height, 1)
    let peak = 0
    for (let j = 0; j < cells; j++) {
      for (let i = 0; i < cells; i++) {
        const cell = j * cells + i
        let valueX = x[cell] as number
        let valueY = y[cell] as number
        if (swirl > 0 && (valueX !== 0 || valueY !== 0)) {
          // Semi-Lagrangian: take the value from where this cell's content came from.
          const fromX = Math.max(0, Math.min(cells - 1, i - valueX * driftX))
          const fromY = Math.max(0, Math.min(cells - 1, j - valueY * driftY))
          valueX = sampleAt(x, cells, fromX, fromY)
          valueY = sampleAt(y, cells, fromX, fromY)
        }
        const left = j * cells + Math.max(0, i - 1)
        const right = j * cells + Math.min(cells - 1, i + 1)
        const below = Math.max(0, j - 1) * cells + i
        const above = Math.min(cells - 1, j + 1) * cells + i
        const averageX =
          ((x[left] as number) +
            (x[right] as number) +
            (x[below] as number) +
            (x[above] as number)) /
          4
        const averageY =
          ((y[left] as number) +
            (y[right] as number) +
            (y[below] as number) +
            (y[above] as number)) /
          4
        valueX = (valueX + (averageX - valueX) * SPREAD) * fade
        valueY = (valueY + (averageY - valueY) * SPREAD) * fade
        nextX[cell] = valueX
        nextY[cell] = valueY
        peak = Math.max(peak, Math.abs(valueX), Math.abs(valueY))
      }
    }
    x.set(nextX)
    y.set(nextY)
    this.peak = peak
    if (peak < REST) this.clear()
  }

  clear(): void {
    this.x.fill(0)
    this.y.fill(0)
    this.peak = 0
  }

  /**
   * Packs the field into half floats, four per cell: the displacement in px, then the slope of
   * its length (px per px), which the water style reads as the slope of a surface.
   */
  write(out: Uint16Array, width: number, height: number): void {
    const cells = this.size
    const lengths = this.#m
    for (let cell = 0; cell < cells * cells; cell++) {
      lengths[cell] = Math.hypot(this.x[cell] as number, this.y[cell] as number)
    }
    const cellWidth = Math.max(width, 1) / cells
    const cellHeight = Math.max(height, 1) / cells
    for (let j = 0; j < cells; j++) {
      for (let i = 0; i < cells; i++) {
        const cell = j * cells + i
        // Central differences, one-sided at the edges.
        const slopeX =
          ((lengths[j * cells + Math.min(cells - 1, i + 1)] as number) -
            (lengths[j * cells + Math.max(0, i - 1)] as number)) /
          (2 * cellWidth)
        const slopeY =
          ((lengths[Math.min(cells - 1, j + 1) * cells + i] as number) -
            (lengths[Math.max(0, j - 1) * cells + i] as number)) /
          (2 * cellHeight)
        out[4 * cell] = DataUtils.toHalfFloat(this.x[cell] as number)
        out[4 * cell + 1] = DataUtils.toHalfFloat(this.y[cell] as number)
        out[4 * cell + 2] = DataUtils.toHalfFloat(slopeX)
        out[4 * cell + 3] = DataUtils.toHalfFloat(slopeY)
      }
    }
  }
}

/** Bilinear read of a field channel at fractional cell coordinates inside the grid. */
function sampleAt(values: Float32Array, cells: number, x: number, y: number): number {
  const i = Math.min(cells - 2, Math.floor(x))
  const j = Math.min(cells - 2, Math.floor(y))
  const tx = x - i
  const ty = y - j
  const bottomLeft = values[j * cells + i] as number
  const bottomRight = values[j * cells + i + 1] as number
  const topLeft = values[(j + 1) * cells + i] as number
  const topRight = values[(j + 1) * cells + i + 1] as number
  const bottom = bottomLeft + (bottomRight - bottomLeft) * tx
  const top = topLeft + (topRight - topLeft) * tx
  return bottom * (1 - ty) + top * ty
}

/**
 * The pointer leaves a fluid trail on a photo: the picture refracts, smears or splits into its
 * colours along the path and settles back. A finger draws while it is pressed.
 */
const liquid: Effect<Params> = defineEffect({
  name: 'liquid',
  params: {
    style: oneOf('water', 'smear', 'prism'),
    strength: 1,
    radius: 80,
    duration: 1.5,
    swirl: 0.5,
    shine: 0.5,
    split: 1,
    resolution: 64,
  },
  rebuild: ['resolution'],
  media: true,
  // The whole point is the motion: under reduced motion the image stays DOM.
  reducedMotion: 'off',
  quality: { low: { resolution: 32 } },
  setup(ctx: EffectContext<Params>) {
    const { params, u, surface } = ctx
    const style = params.style
    const size = Math.max(8, Math.min(256, Math.round(params.resolution)))
    const field = new Field(size)
    const data = new Uint16Array(size * size * 4)
    const map = new DataTexture(data, size, size, RGBAFormat, HalfFloatType)
    map.wrapS = map.wrapT = ClampToEdgeWrapping
    map.magFilter = map.minFilter = LinearFilter
    map.colorSpace = NoColorSpace
    map.generateMipmaps = false
    map.needsUpdate = true
    ctx.onDispose(() => map.dispose())

    // The field at box UV: displacement in px (xy) and the slope of its length (zw).
    const fieldAt = (box: V2): V4 => texture(map, box) as unknown as V4
    const boxSize = u.size as unknown as V2
    surface.uv((uv) => {
      const cell = fieldAt(uv)
      // Water refracts by the slope of the trail; smear and prism drag the picture along it.
      const offset =
        style === 'water' ? cell.zw.mul(u.strength).mul(DEPTH) : cell.xy.mul(u.strength).mul(1.2)
      return uv.sub(offset.div(boxSize)).clamp(0, 1)
    })
    if (style === 'water') {
      surface.color((color, { box }) => {
        const cell = fieldAt(box)
        const lit = dot(cell.zw, vec2(LIGHT[0], LIGHT[1])).negate().mul(u.shine)
        const glint = smoothstep(0.03, 0.35, lit).mul(0.4)
        return vec4(color.rgb.mul(lit.mul(0.9).add(1)).add(glint), color.a)
      })
    } else if (style === 'prism') {
      surface.color((color, { uv, box, sample }) => {
        // Only the split adds to what earlier effects made, so a still field is a no-op.
        const shift = fieldAt(box).xy.mul(u.split).mul(0.25).div(boxSize)
        const here = sample(uv)
        const red = color.r.add(sample(uv.add(shift).clamp(0, 1)).r.sub(here.r))
        const blue = color.b.add(sample(uv.sub(shift).clamp(0, 1)).b.sub(here.b))
        return vec4(max(red, 0), color.g, max(blue, 0), color.a)
      })
    }

    // Pointer points in client px since the last frame; null breaks the stroke.
    const queue: ({ x: number; y: number } | null)[] = []
    const push = (point: { x: number; y: number } | null): void => {
      if (queue.length >= QUEUE) queue.splice(0, queue.length - QUEUE + 1)
      queue.push(point)
      ctx.invalidate()
    }
    const point = (e: PointerEvent): void => push({ x: e.clientX, y: e.clientY })
    // Touch draws while the finger is pressed; a scroll takes the gesture with pointercancel.
    follow(ctx, {
      enter(e) {
        push(null)
        point(e)
      },
      move: point,
      leave: () => push(null),
    })

    let last: { x: number; y: number } | undefined
    let time = 0
    let dirty = false
    return (input): boolean => {
      const { width, height } = input
      // A page transition takes the copy as it is: no new trail while it plays.
      const live = input.presence >= 1 && params.strength > 0
      for (const queued of queue) {
        if (!queued) {
          last = undefined
          continue
        }
        const next = toBox(queued, input)
        if (last && live) field.stroke(last.x, last.y, next.x, next.y, params.radius, width, height)
        last = next
      }
      queue.length = 0
      if (!live && field.peak > 0) field.clear()
      if (field.peak > 0) {
        time = Math.min(time + Math.max(0, input.delta), STEP * CATCH_UP)
        while (time >= STEP && field.peak > 0) {
          time -= STEP
          field.step(STEP, params.duration, Math.max(0, params.swirl), width, height)
        }
        dirty = true
      } else time = 0
      if (dirty) {
        field.write(data, width, height)
        map.needsUpdate = true
        dirty = field.peak > 0
      }
      return field.peak > 0
    }
  },
})
export default liquid
