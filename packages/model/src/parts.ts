// Node lookups shared by the effects that work on a model's parts.
import { Box3, Matrix4, type Mesh, type Object3D, PropertyBinding } from 'three/webgpu'

/** A file's node by name, as written or as three's loader renames it. */
export function find(file: Object3D, name: string): Object3D | undefined {
  return file.getObjectByName(name) ?? file.getObjectByName(PropertyBinding.sanitizeNodeName(name))
}

/** Bounds of the meshes under `node` in the space whose world matrix inverse is `inverse`. */
export function bounds(node: Object3D, inverse: Matrix4): Box3 {
  const box = new Box3()
  const part = new Box3()
  const toSpace = new Matrix4()
  node.traverse((object) => {
    const mesh = object as Mesh
    if (!mesh.isMesh || !mesh.geometry) return
    if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox()
    const own = mesh.geometry.boundingBox
    if (!own) return
    box.union(part.copy(own).applyMatrix4(toSpace.multiplyMatrices(inverse, mesh.matrixWorld)))
  })
  return box
}
