// Procedural shapes of the product effects (device, book): rounded slabs, flat panels and the
// curved strip of a spine, with smooth normals and box UV.
import { BufferGeometry, Float32BufferAttribute } from 'three/webgpu'

/** Radii of the top-right, top-left, bottom-left and bottom-right corners. */
export type Corners = readonly [number, number, number, number]

/** Signs of each corner's arc centre, in the order of `Corners`. */
const CENTRES = [
  [1, 1],
  [-1, 1],
  [-1, -1],
  [1, -1],
] as const

/** A rounded rectangle's outline, counterclockwise from the top-right corner, with outward normals. */
export function outline(
  width: number,
  height: number,
  radii: Corners,
  segments: number,
): { points: number[]; normals: number[] } {
  const halfWidth = width / 2
  const halfHeight = height / 2
  const points: number[] = []
  const normals: number[] = []
  for (let corner = 0; corner < 4; corner++) {
    const r = Math.max(0, Math.min(radii[corner] as number, halfWidth, halfHeight))
    const [sx, sy] = CENTRES[corner] as readonly [number, number]
    const cx = sx * (halfWidth - r)
    const cy = sy * (halfHeight - r)
    for (let i = 0; i <= segments; i++) {
      const angle = ((corner + i / segments) * Math.PI) / 2
      const nx = Math.cos(angle)
      const ny = Math.sin(angle)
      points.push(cx + nx * r, cy + ny * r)
      normals.push(nx, ny)
    }
  }
  return { points, normals }
}

function geometry(position: number[], normal: number[], uv: number[], index: number[]) {
  const made = new BufferGeometry()
  made.setAttribute('position', new Float32BufferAttribute(position, 3))
  made.setAttribute('normal', new Float32BufferAttribute(normal, 3))
  made.setAttribute('uv', new Float32BufferAttribute(uv, 2))
  made.setIndex(index)
  return made
}

/** A flat rounded rectangle facing +z, UV 0..1 over its box. */
export function panel(
  width: number,
  height: number,
  radius: number | Corners,
  segments = 12,
): BufferGeometry {
  const radii: Corners = typeof radius === 'number' ? [radius, radius, radius, radius] : radius
  const { points } = outline(width, height, radii, segments)
  const count = points.length / 2
  // A fan around a centre vertex.
  const position = [0, 0, 0]
  const normal = [0, 0, 1]
  const uv = [0.5, 0.5]
  const index: number[] = []
  for (let i = 0; i < count; i++) {
    const x = points[2 * i] as number
    const y = points[2 * i + 1] as number
    position.push(x, y, 0)
    normal.push(0, 0, 1)
    uv.push(x / width + 0.5, y / height + 0.5)
    index.push(0, 1 + i, 1 + ((i + 1) % count))
  }
  return geometry(position, normal, uv, index)
}

/**
 * A rounded slab centred on the origin: a `width` × `height` rectangle with corners of `radius`,
 * `depth` thick along z, its edges rounded by `edge`. Groups: 0 the front face (+z), 1 the back
 * face, 2 the sides. Face UV is box UV as seen from that face.
 */
export function slab(
  width: number,
  height: number,
  depth: number,
  radius: number,
  edge: number,
  segments = 10,
  bevel = 4,
): BufferGeometry {
  const e = Math.max(0, Math.min(edge, depth / 2, width / 2, height / 2))
  const r = Math.max(0, radius - e)
  // The outline of the slab inset by the edge radius: the bevel rings grow out from it.
  const { points, normals } = outline(width - 2 * e, height - 2 * e, [r, r, r, r], segments)
  const n = points.length / 2
  const capZ = depth / 2 - e
  // The edge's cross-section: cosine out, sine along z and the ring's centre z, from the front
  // face round to the back one.
  const profile: [number, number, number][] = []
  for (let k = 0; k <= bevel; k++) {
    const phi = ((1 - k / bevel) * Math.PI) / 2
    profile.push([Math.cos(phi), Math.sin(phi), capZ])
  }
  for (let k = 0; k <= bevel; k++) {
    const phi = (-(k / bevel) * Math.PI) / 2
    profile.push([Math.cos(phi), Math.sin(phi), -capZ])
  }
  const position: number[] = []
  const normal: number[] = []
  const uv: number[] = []
  const index: number[] = []
  const cap = (z: number, facing: 1 | -1): void => {
    const base = position.length / 3
    position.push(0, 0, z)
    normal.push(0, 0, facing)
    uv.push(0.5, 0.5)
    for (let i = 0; i < n; i++) {
      const x = points[2 * i] as number
      const y = points[2 * i + 1] as number
      position.push(x, y, z)
      normal.push(0, 0, facing)
      uv.push(facing > 0 ? x / width + 0.5 : 0.5 - x / width, y / height + 0.5)
    }
    for (let i = 0; i < n; i++) {
      const a = base + 1 + i
      const b = base + 1 + ((i + 1) % n)
      if (facing > 0) index.push(base, a, b)
      else index.push(base, b, a)
    }
  }
  cap(depth / 2, 1)
  const front = index.length
  cap(-depth / 2, -1)
  const back = index.length
  const base = position.length / 3
  profile.forEach(([out, along, z], ring) => {
    for (let i = 0; i < n; i++) {
      const nx = normals[2 * i] as number
      const ny = normals[2 * i + 1] as number
      position.push(
        (points[2 * i] as number) + nx * e * out,
        (points[2 * i + 1] as number) + ny * e * out,
        z + e * along,
      )
      normal.push(nx * out, ny * out, along)
      uv.push(i / n, ring / (profile.length - 1))
    }
  })
  for (let ring = 0; ring < profile.length - 1; ring++) {
    for (let i = 0; i < n; i++) {
      const a = base + ring * n + i
      const b = base + ring * n + ((i + 1) % n)
      const c = b + n
      const d = a + n
      index.push(a, d, c, a, c, b)
    }
  }
  const made = geometry(position, normal, uv, index)
  made.addGroup(0, front, 0)
  made.addGroup(front, back - front, 1)
  made.addGroup(back, index.length - back, 2)
  return made
}

/**
 * The outer face of a spine: from z = 0 back to z = -width at x = 0, bulging toward -x by `bulge`
 * in the middle, `height` tall. UV u runs from the back edge to the front one, as a spine image
 * reads with the book standing on a shelf.
 */
export function strip(height: number, width: number, bulge: number, segments = 12): BufferGeometry {
  const position: number[] = []
  const normal: number[] = []
  const uv: number[] = []
  const index: number[] = []
  for (let i = 0; i <= segments; i++) {
    const t = i / segments
    const x = -bulge * Math.sin(Math.PI * t)
    const z = -width * t
    const nx = -width
    const nz = bulge * Math.PI * Math.cos(Math.PI * t)
    const length = Math.hypot(nx, nz) || 1
    for (const y of [-height / 2, height / 2]) {
      position.push(x, y, z)
      normal.push(nx / length, 0, nz / length)
      uv.push(1 - t, y / height + 0.5)
    }
  }
  for (let i = 0; i < segments; i++) {
    const a = 2 * i
    const b = 2 * (i + 1)
    const c = b + 1
    const d = a + 1
    index.push(a, c, b, a, d, c)
  }
  return geometry(position, normal, uv, index)
}

/** One geometry of several with position, normal and UV each, no groups. */
export function merge(parts: readonly BufferGeometry[]): BufferGeometry {
  const position: number[] = []
  const normal: number[] = []
  const uv: number[] = []
  const index: number[] = []
  for (const part of parts) {
    const base = position.length / 3
    position.push(...(part.getAttribute('position').array as Float32Array))
    normal.push(...(part.getAttribute('normal').array as Float32Array))
    uv.push(...(part.getAttribute('uv').array as Float32Array))
    for (const i of part.getIndex()?.array ?? []) index.push(base + i)
    part.dispose()
  }
  return geometry(position, normal, uv, index)
}
