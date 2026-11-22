# @dioramajs/diorama

three.js effects for plain HTML. One attribute on any element.

```html
<img src="/harbour.jpg" alt="The harbour at dusk" data-dio="ripple" />
```

The image becomes a WebGL plane that keeps its place in the layout while the page scrolls and reflows. three.js loads after the first paint, each effect loads when its element nears the viewport, and frames are drawn only while something on screen changes. Rendering uses WebGPU with a WebGL 2 fallback.

## Install

```bash
npm install @dioramajs/diorama three
```

```ts
// vite.config.ts
import { diorama } from '@dioramajs/diorama/vite'

export default { plugins: [diorama()] }
```

```ts
// src/main.ts
import { start } from '@dioramajs/diorama'

export const app = start()
```

Astro, Nuxt and Next.js have their own integrations (`@dioramajs/diorama/astro`, `@dioramajs/diorama/nuxt`, `@dioramajs/diorama/next`), and a page without a build step needs one script tag:

```html
<script type="module" src="https://cdn.jsdelivr.net/npm/@dioramajs/diorama/dist/cdn/auto.js"></script>
```

## Your own effects

Every file in `src/effects/` is an effect named after the file:

```ts
// src/effects/brighten.ts
import { effect } from '@dioramajs/diorama'

export default effect({ strength: 1 }, ({ surface, u }) => {
  surface.color((color) => color.mul(u.strength.add(1)))
})
```

```html
<img src="/cover.jpg" alt="" data-dio="brighten" data-dio-strength="2" />
```

Copy a built-in into your folder to start from it: `npx dioramajs add spotlight`.

## Docs

- [Get started](https://dioramajs.dev/docs/start)
- [100 effects](https://dioramajs.dev/docs/effects)
- [Your own effect in 10 minutes](https://dioramajs.dev/docs/learn/effect-in-10-minutes)
- [API reference](https://dioramajs.dev/docs/api/diorama)
- [Diorama on GitHub](https://github.com/MasterKurosava/diorama)

## License

MIT
