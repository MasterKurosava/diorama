// Types of `?shader`, `?effect` and `?entry` imports: add "@diorama/glsl/client" to tsconfig `types`.
declare module '*?shader' {
  const shader: import('@diorama/glsl').GlslShader
  export default shader
}
declare module '*?effect' {
  const effect: import('@diorama/effects').Effect
  export default effect
}
declare module '*?entry' {
  const entry: import('@diorama/effects').EffectEntry
  export default entry
}
