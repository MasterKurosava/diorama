// Types of `?shader`, `?effect` and `?entry` imports: add "@dioramajs/glsl/client" to tsconfig `types`.
declare module '*?shader' {
  const shader: import('@dioramajs/glsl').GlslShader
  export default shader
}
declare module '*?effect' {
  const effect: import('@dioramajs/effects').Effect
  export default effect
}
declare module '*?entry' {
  const entry: import('@dioramajs/effects').EffectEntry
  export default entry
}
