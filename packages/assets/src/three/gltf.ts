import type { GLTF } from 'three/addons/loaders/GLTFLoader.js'
import type {
  BufferGeometry,
  CompressedTexture,
  Material,
  Mesh,
  Object3D,
  SkinnedMesh,
  Texture,
} from 'three/webgpu'
import { AssetError } from '../errors'
import type { AssetLoader, Loaded, Model } from '../types'
import { dracoLoader, KTX2, ktx2Loader, meshoptDecoder, parseError, refused } from './decoders'
import { rgbaBytes } from './texture'

const GLB = 0x46546c67
const JSON_CHUNK = 0x4e4f534a
const DRACO = 'KHR_draco_mesh_compression'
const MESHOPT = ['EXT_meshopt_compression', 'KHR_meshopt_compression']
const BASISU = 'KHR_texture_basisu'

/**
 * The extensions a file uses, from the JSON chunk of a GLB or the .gltf text. Reads
 * `extensionsUsed`, not only the required ones, or an optional one would fall back silently.
 */
export function extensionsUsed(buffer: ArrayBuffer): Set<string> {
  const view = new DataView(buffer)
  let text = new Uint8Array(buffer)
  if (buffer.byteLength >= 20 && view.getUint32(0, true) === GLB) {
    if (view.getUint32(16, true) !== JSON_CHUNK) throw new Error('the GLB has no JSON chunk')
    text = new Uint8Array(buffer, 20, view.getUint32(12, true))
  }
  const json = JSON.parse(new TextDecoder().decode(text)) as {
    extensionsUsed?: string[]
    extensionsRequired?: string[]
  }
  return new Set([...(json.extensionsUsed ?? []), ...(json.extensionsRequired ?? [])])
}

interface Resources {
  readonly geometries: Set<BufferGeometry>
  readonly materials: Set<Material>
  readonly textures: Set<Texture>
}

function resources(root: Object3D): Resources {
  const found: Resources = { geometries: new Set(), materials: new Set(), textures: new Set() }
  root.traverse((object) => {
    const { geometry, material } = object as Mesh
    if (geometry) found.geometries.add(geometry)
    for (const each of [material ?? []].flat() as Material[]) {
      found.materials.add(each)
      for (const value of Object.values(each)) {
        if ((value as Texture | null)?.isTexture) found.textures.add(value)
      }
    }
  })
  return found
}

const geometryBytes = (geometry: BufferGeometry): number =>
  [...Object.values(geometry.attributes), geometry.index].reduce(
    (sum, attribute) => sum + ((attribute?.array as ArrayBufferView | undefined)?.byteLength ?? 0),
    0,
  )

function textureBytes(texture: Texture): number {
  const compressed = texture as CompressedTexture
  if (compressed.isCompressedTexture) {
    return compressed.mipmaps.reduce((sum, level) => sum + (level.data?.byteLength ?? 0), 0)
  }
  return rgbaBytes(texture.image ?? {})
}

/** Shared resources are marked `userData.keep`, effects get clones. */
function model(gltf: GLTF, cloneSkinned: (root: Object3D) => Object3D): Loaded<Model> {
  const { scene, animations } = gltf
  const found = resources(scene)
  for (const set of [found.geometries, found.materials, found.textures]) {
    for (const resource of set) resource.userData.keep = true
  }
  let skinned = false
  scene.traverse((object) => {
    if ((object as SkinnedMesh).isSkinnedMesh) skinned = true
  })
  const textures = [...found.textures]
  return {
    value: {
      scene,
      animations,
      instance: () => (skinned ? cloneSkinned(scene) : scene.clone()),
    },
    bytes:
      [...found.geometries].reduce((sum, g) => sum + geometryBytes(g), 0) +
      textures.reduce((sum, t) => sum + textureBytes(t), 0),
    renderBound: textures.some((t) => (t as CompressedTexture).isCompressedTexture),
    dispose() {
      scene.traverse((object) => object.dispose())
      for (const geometry of found.geometries) geometry.dispose()
      for (const material of found.materials) material.dispose()
      for (const texture of textures) {
        texture.dispose()
        ;(texture.image as { close?: () => void } | null)?.close?.()
      }
    },
  }
}

/** glTF and GLB with the decoders their `extensionsUsed` name, loaded on demand. */
export const gltf: AssetLoader<Model> = {
  async load(context) {
    const { url } = context
    const [{ GLTFLoader }, { clone }, buffer] = await Promise.all([
      import('three/addons/loaders/GLTFLoader.js'),
      import('three/addons/utils/SkeletonUtils.js'),
      context.fetch().then((response) => context.bytes(response)),
    ])
    let used: Set<string>
    try {
      used = extensionsUsed(buffer)
    } catch (cause) {
      throw new AssetError('ASSET_PARSE', `${url} is not glTF`, { url, cause })
    }
    const loader = new GLTFLoader()
    if (context.crossOrigin === 'use-credentials') {
      loader.setCrossOrigin('use-credentials').setWithCredentials(true)
    }
    loader.setPriority(context.priority === 'normal' ? 'auto' : context.priority)
    const { decoders } = context
    const meshopt = MESHOPT.some((name) => used.has(name))
    if (used.has(DRACO)) loader.setDRACOLoader(await dracoLoader(decoders, url))
    if (meshopt) loader.setMeshoptDecoder(await meshoptDecoder(decoders, url))
    if (used.has(BASISU)) {
      // Refused before waiting for a render that may never come.
      if (decoders.ktx2 === false) throw refused(KTX2, 'ktx2', url)
      const { renderer } = await context.render()
      loader.setKTX2Loader(await ktx2Loader(renderer, decoders, url))
    }
    const base = url.slice(0, url.lastIndexOf('/') + 1)
    try {
      return model(await context.decode(() => loader.parseAsync(buffer, base)), clone)
    } catch (cause) {
      throw parseError(cause, context, meshopt || used.has(DRACO) || used.has(BASISU))
    }
  },
}
