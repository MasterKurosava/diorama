import type { Material, Object3D } from 'three/webgpu'

interface Resource {
  readonly userData?: { readonly keep?: unknown }
  dispose(): void
}
interface Drawable {
  readonly geometry?: Resource
  readonly material?: Material | readonly Material[]
  readonly isSprite?: boolean
  readonly skeleton?: { dispose(): void }
}
interface TextureLike extends Resource {
  readonly isTexture?: boolean
  readonly isRenderTargetTexture?: boolean
}

/**
 * Frees what an effect's objects hold. Every object gets `dispose()`, which in r187 is what drops
 * its render objects and uniform buffers while its materials are shared. Then geometries,
 * materials and textures on a material's own properties go, except shared ones: whatever `keep`
 * accepts (surface geometry, `ctx.map`) and anything with `userData.keep`. An object with
 * `userData.keep` spares the resources of its subtree but not the objects. The module-wide
 * Sprite geometry is never touched.
 */
export function deepDispose(
  root: Object3D,
  keep: (resource: object) => boolean,
  shared = false,
): void {
  const object = root as Object3D & Drawable
  object.dispose()
  const own = !shared && root.userData.keep !== true
  if (own) {
    const spare = (r: Resource): boolean => keep(r) || r.userData?.keep === true
    const { geometry, material, isSprite } = object
    object.skeleton?.dispose()
    if (geometry && !isSprite && !spare(geometry)) geometry.dispose()
    for (const m of [material ?? []].flat()) {
      if (spare(m)) continue
      for (const value of Object.values(m)) {
        const texture = value as TextureLike | null
        if (texture?.isTexture && !texture.isRenderTargetTexture && !spare(texture))
          texture.dispose()
      }
      m.dispose()
    }
  }
  for (const child of root.children) deepDispose(child, keep, !own)
}
