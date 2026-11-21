// Distance fields and blurs of glyph coverage on the CPU, computed once per raster. Shared by the
// effects of the module; runs only in their chunks.

const INF = 1e20

/**
 * One line of the squared distance transform (Felzenszwalb and Huttenlocher), with the paper's
 * names: `f` the input, `d` the output, `v` the parabola apexes and `z` their boundaries.
 */
function line(f: Float64Array, n: number, d: Float64Array, v: Int32Array, z: Float64Array): void {
  let k = 0
  v[0] = 0
  z[0] = -INF
  z[1] = INF
  for (let q = 1; q < n; q++) {
    let r = v[k] as number
    let s = ((f[q] as number) + q * q - ((f[r] as number) + r * r)) / (2 * q - 2 * r)
    while (s <= (z[k] as number) && k > 0) {
      k--
      r = v[k] as number
      s = ((f[q] as number) + q * q - ((f[r] as number) + r * r)) / (2 * q - 2 * r)
    }
    k++
    v[k] = q
    z[k] = s
    z[k + 1] = INF
  }
  k = 0
  for (let q = 0; q < n; q++) {
    while ((z[k + 1] as number) < q) k++
    const r = v[k] as number
    d[q] = (q - r) * (q - r) + (f[r] as number)
  }
}

/** Squared distance to the nearest zero of `grid`, in place. */
function transform(grid: Float64Array, w: number, h: number): void {
  const longest = Math.max(w, h)
  const input = new Float64Array(longest)
  const output = new Float64Array(longest)
  const bounds = new Float64Array(longest + 1)
  const apexes = new Int32Array(longest)
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) input[y] = grid[y * w + x] as number
    line(input, h, output, apexes, bounds)
    for (let y = 0; y < h; y++) grid[y * w + x] = output[y] as number
  }
  for (let y = 0; y < h; y++) {
    const row = y * w
    for (let x = 0; x < w; x++) input[x] = grid[row + x] as number
    line(input, w, output, apexes, bounds)
    for (let x = 0; x < w; x++) grid[row + x] = output[x] as number
  }
}

/**
 * Signed distance in pixels to the edge of the coverage `alpha` (0..1 per pixel, w by h, rows
 * top down), negative inside; edge pixels use their coverage for sub-pixel accuracy. Exact
 * Euclidean distances in two linear passes.
 */
export function distance(alpha: Float32Array, w: number, h: number): Float32Array {
  const outer = new Float64Array(w * h).fill(INF)
  const inner = new Float64Array(w * h)
  for (let i = 0; i < w * h; i++) {
    const cover = alpha[i] as number
    if (cover <= 0) continue
    if (cover >= 1) {
      outer[i] = 0
      inner[i] = INF
    } else {
      // A partly covered pixel sits this far from the edge.
      const offset = 0.5 - cover
      outer[i] = offset > 0 ? offset * offset : 0
      inner[i] = offset < 0 ? offset * offset : 0
    }
  }
  transform(outer, w, h)
  transform(inner, w, h)
  const out = new Float32Array(w * h)
  for (let i = 0; i < w * h; i++)
    out[i] = Math.sqrt(outer[i] as number) - Math.sqrt(inner[i] as number)
  return out
}

/**
 * Unit direction of steepest ascent of `field` (w by h) from a 3 by 3 Sobel kernel, x then y per
 * pixel: for a distance field the outward normal of the edge, without the stair steps of single
 * differences. 0, 0 where it is flat.
 */
export function gradient(field: Float32Array, w: number, h: number): Float32Array {
  const out = new Float32Array(w * h * 2)
  for (let y = 0; y < h; y++) {
    const up = (y > 0 ? y - 1 : y) * w
    const row = y * w
    const down = (y < h - 1 ? y + 1 : y) * w
    for (let x = 0; x < w; x++) {
      const left = x > 0 ? x - 1 : x
      const right = x < w - 1 ? x + 1 : x
      const ul = field[up + left] as number
      const ur = field[up + right] as number
      const dl = field[down + left] as number
      const dr = field[down + right] as number
      const gx =
        ur + dr - ul - dl + 2 * ((field[row + right] as number) - (field[row + left] as number))
      const gy = dl + dr - ul - ur + 2 * ((field[down + x] as number) - (field[up + x] as number))
      const len = Math.hypot(gx, gy)
      if (len < 1e-6) continue
      out[(row + x) * 2] = gx / len
      out[(row + x) * 2 + 1] = gy / len
    }
  }
  return out
}

/** Widths of three box blurs that together approximate a Gaussian of `sigma`. */
function boxes(sigma: number): number[] {
  const ideal = Math.sqrt((12 * sigma * sigma) / 3 + 1)
  // Odd widths: the narrower one for the first `narrow` passes, two wider for the rest.
  let lo = Math.floor(ideal)
  if (lo % 2 === 0) lo--
  const narrow = Math.round((12 * sigma * sigma - 3 * lo * lo - 12 * lo - 9) / (-4 * lo - 4))
  return [0, 1, 2].map((i) => (i < narrow ? lo : lo + 2))
}

/** One box pass of `radius` along rows (`across`) or columns, with zeros past the edges. */
function pass(
  src: Float32Array,
  dst: Float32Array,
  w: number,
  h: number,
  radius: number,
  across: boolean,
): void {
  const [length, lines, stride, jump] = across ? [w, h, 1, w] : [h, w, w, 1]
  const weight = 1 / (2 * radius + 1)
  for (let line = 0; line < lines; line++) {
    const start = line * jump
    let sum = 0
    for (let i = 0; i < Math.min(radius, length); i++) sum += src[start + i * stride] as number
    for (let i = 0; i < length; i++) {
      if (i + radius < length) sum += src[start + (i + radius) * stride] as number
      dst[start + i * stride] = sum * weight
      if (i - radius >= 0) sum -= src[start + (i - radius) * stride] as number
    }
  }
}

/** A Gaussian blur of `src` (w by h) with zeros past its edges, as three box blurs. */
export function blur(src: Float32Array, w: number, h: number, sigma: number): Float32Array {
  const image = Float32Array.from(src)
  if (sigma < 0.3) return image
  const scratch = new Float32Array(image.length)
  for (const size of boxes(sigma)) {
    const radius = (size - 1) / 2
    pass(image, scratch, w, h, radius, true)
    pass(scratch, image, w, h, radius, false)
  }
  return image
}

/** Pixels of a canvas region as RGBA bytes; zeros where the canvas cannot be read. */
export function read(canvas: HTMLCanvasElement, w: number, h: number): Uint8ClampedArray {
  const data = canvas.getContext('2d')?.getImageData(0, 0, w, h)?.data
  return data?.length === w * h * 4 ? data : new Uint8ClampedArray(w * h * 4)
}

/** The alpha of a canvas region, 0..1 per pixel; zeros where the canvas cannot be read. */
export function coverage(canvas: HTMLCanvasElement, w: number, h: number): Float32Array {
  const pixels = read(canvas, w, h)
  const alpha = new Float32Array(w * h)
  for (let i = 0; i < alpha.length; i++) alpha[i] = (pixels[i * 4 + 3] as number) / 255
  return alpha
}

/**
 * Resizes a canvas to w by h and fills it with RGBA bytes from `fill`; leaves it blank without
 * image data support.
 */
export function write(
  canvas: HTMLCanvasElement,
  w: number,
  h: number,
  fill: (px: Uint8ClampedArray) => void,
): void {
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  const image = typeof ctx?.createImageData === 'function' ? ctx.createImageData(w, h) : undefined
  if (!ctx || !image || image.data.length !== w * h * 4) return
  fill(image.data)
  ctx.putImageData(image, 0, 0)
}

/**
 * Makes `field` (from `distance`: px, negative inside) exact within `band` px of the edge: the
 * distance to the 0.5 contour of `alpha`, traced between pixel centres (marching squares). The
 * transform alone steps from pixel to pixel along a curve, which streaks normals taken from it.
 */
export function refine(
  alpha: Float32Array,
  w: number,
  h: number,
  field: Float32Array,
  band = 3,
): void {
  // Cells between four pixel centres.
  const cellsX = w - 1
  const cellsY = h - 1
  if (cellsX < 1 || cellsY < 1) return
  // The segments of each cell, x0 y0 x1 y1 with pixel centres at integers.
  const first = new Int32Array(cellsX * cellsY + 1)
  const segments: number[] = []
  /** Where the 0.5 contour crosses between two pixels, 0..1 from the first. */
  const crossing = (from: number, to: number): number => (0.5 - from) / (to - from)
  for (let y = 0; y < cellsY; y++)
    for (let x = 0; x < cellsX; x++) {
      first[y * cellsX + x] = segments.length / 4
      const i = y * w + x
      const tl = alpha[i] as number
      const tr = alpha[i + 1] as number
      const br = alpha[i + w + 1] as number
      const bl = alpha[i + w] as number
      const code =
        (tl >= 0.5 ? 1 : 0) | (tr >= 0.5 ? 2 : 0) | (br >= 0.5 ? 4 : 0) | (bl >= 0.5 ? 8 : 0)
      if (code === 0 || code === 15) continue
      // Crossings on the top, right, bottom and left sides, in that order.
      const points: number[] = []
      if ((code & 1) !== (code & 2) >> 1) points.push(x + crossing(tl, tr), y)
      if ((code & 2) >> 1 !== (code & 4) >> 2) points.push(x + 1, y + crossing(tr, br))
      if ((code & 8) >> 3 !== (code & 4) >> 2) points.push(x + crossing(bl, br), y + 1)
      if ((code & 1) !== (code & 8) >> 3) points.push(x, y + crossing(tl, bl))
      if (points.length === 4) segments.push(...points)
      else if (points.length === 8) {
        // A saddle: the centre decides which corners the contour cuts off.
        const inside = (tl + tr + br + bl) / 4 >= 0.5
        const [tx, ty, rx, ry, bx, by, lx, ly] = points as [
          number,
          number,
          number,
          number,
          number,
          number,
          number,
          number,
        ]
        if ((code === 5) === inside) segments.push(tx, ty, rx, ry, bx, by, lx, ly)
        else segments.push(tx, ty, lx, ly, rx, ry, bx, by)
      }
    }
  first[cellsX * cellsY] = segments.length / 4
  const ends = Float32Array.from(segments)
  // Cells this far around a pixel can hold the contour within `band`.
  const reach = Math.ceil(band) + 1
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      const dist = field[i] as number
      if (dist > band || dist < -band) continue
      // Squared distance to the closest segment nearby.
      let best = Number.POSITIVE_INFINITY
      for (let cy = Math.max(0, y - reach); cy < Math.min(cellsY, y + reach); cy++)
        for (let cx = Math.max(0, x - reach); cx < Math.min(cellsX, x + reach); cx++) {
          const cell = cy * cellsX + cx
          for (let k = first[cell] as number; k < (first[cell + 1] as number); k++) {
            const x0 = ends[k * 4] as number
            const y0 = ends[k * 4 + 1] as number
            const dx = (ends[k * 4 + 2] as number) - x0
            const dy = (ends[k * 4 + 3] as number) - y0
            const len = dx * dx + dy * dy
            const t = len > 0 ? Math.min(1, Math.max(0, ((x - x0) * dx + (y - y0) * dy) / len)) : 0
            const ex = x0 + t * dx - x
            const ey = y0 + t * dy - y
            const squared = ex * ex + ey * ey
            if (squared < best) best = squared
          }
        }
      if (best < Number.POSITIVE_INFINITY)
        field[i] = ((alpha[i] as number) >= 0.5 ? -1 : 1) * Math.sqrt(best)
    }
}
