# @dioramajs/glsl

Converts GLSL fragment shaders to three.js TSL at build time. Shaders written for `ShaderMaterial`, Shadertoy or The Book of Shaders run on the `WebGPURenderer`, and the browser gets only the generated TSL.

With [Diorama](https://github.com/MasterKurosava/diorama), a `.frag` file in the effects folder becomes an effect, and its uniforms become params.

## Install

```bash
npm install -D @dioramajs/glsl
```

```ts
// vite.config.ts
import { glsl } from '@dioramajs/glsl/vite'
import { diorama } from 'dioramajs/vite'

export default { plugins: [diorama(), glsl()] }
```

```glsl
// src/effects/rgb-shift.frag
uniform sampler2D uTexture;
uniform float uVelocity;
uniform float uStrength; // @default 0.02
varying vec2 vUv;

void main() {
  vec2 shift = vec2(uStrength * uVelocity, 0.0);
  vec4 base = texture2D(uTexture, vUv);
  float r = texture2D(uTexture, vUv + shift).r;
  float b = texture2D(uTexture, vUv - shift).b;
  gl_FragColor = vec4(r, base.g, b, base.a);
}
```

```html
<img src="/cover.jpg" alt="" data-dio="rgb-shift" data-dio-strength="0.04" />
```

Next.js uses the webpack loader, and the `dioramajs-glsl` CLI converts files outside a build.

## Docs

- [Port a GLSL shader](https://dioramajs.dev/docs/guides/glsl)
- [API reference](https://dioramajs.dev/docs/api/glsl)

## License

MIT
