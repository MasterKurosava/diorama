# Diorama

Three.js effects for ordinary HTML pages. Add `data-dio="ripple"` to an image and it turns into a WebGL plane that stays in place while the page scrolls and reflows. Your own effects are files in a folder and work the same way.

Effects attach to DOM elements, so the layout stays in HTML and CSS. three.js and each effect load only when an element with an effect gets close to the viewport, and frames are drawn only while something changes. Elements with the same `data-dio-key` fly from one page to the next on navigation.

Rendering uses WebGPU with a WebGL 2 fallback. Shaders are written in TSL; GLSL shaders can be converted.

The project is in early development and the API can still change.

## Install

```bash
npm install diorama three
```

three 0.187 is required.

## Vite

```ts
// vite.config.ts
import { diorama } from 'diorama/vite'

export default { plugins: [diorama()] }
```

```ts
// src/main.ts
import { start } from 'diorama'

export const app = start()
```

```ts
// src/effects/glow.ts
import { effect } from 'diorama'

export default effect({ amount: 1 }, ({ surface, u }) => {
  surface.color((color) => color.mul(u.amount.add(1)))
})
```

```html
<img src="/cover.jpg" alt="Project cover" data-dio="glow ripple" data-dio-key="cover" />
```

Every file in `src/effects/` is an effect named after the file (`HeroGlow.ts` is `hero-glow`). Files starting with `_` are ignored. The plugin writes types to `src/diorama.gen.d.ts`, so effect names and params are checked in `app.attach('.hero', 'glow', { amount: 2 })`. Commit that file.

Param types come from the defaults: numbers, booleans, 2 to 4 number tuples and colours (`'#ffd27a'`, `rgb(...)`, `hsl(...)`). Use `text('#cafe')` for a string that only looks like a colour.

An effect that reads `u.time` redraws every frame while it is on screen. One that reads `u.hoverTime` redraws only under the pointer. Anything else redraws on scroll, pointer moves and param changes. To set this yourself, pass options before the setup function:

```ts
export default effect({ amount: 1 }, { animate: 'visible', when: 'hover' }, setup)
```

`when: 'hover'` skips the effect on touch devices, so they never load the engine for it.

## Options

```ts
import gsap from 'gsap'
import { ScrollTrigger } from 'gsap/ScrollTrigger'
import Lenis from 'lenis'

export const app = start({
  canvas: 'behind', // draw under the page instead of over it
  background: 0x08080b,
  gsap, // tweens and frames share one ticker
  ScrollTrigger, // pins and scrubs drive the pin and progress inputs
  lenis: new Lenis(), // smooth scroll in sync with the canvas
  transitions: { duration: 0.9 }, // or false
  effects: { extra: () => import('./extra') }, // effects outside the folder
})
```

Calling `start()` again returns the same app. `createApp` and the plugins are exported for full control.

## Astro

```ts
// astro.config.mjs
import diorama from 'diorama/astro'

export default { integrations: [diorama()] }
```

```astro
<!-- src/layouts/Layout.astro -->
<script>
  import { start } from 'diorama'
  start()
</script>
```

With `<ClientRouter />`, keyed elements fly between pages without extra code.

## Nuxt

```ts
// nuxt.config.ts
export default defineNuxtConfig({ modules: ['diorama/nuxt'] })
```

```ts
// app/plugins/diorama.client.ts
import { start } from 'diorama'

export default defineNuxtPlugin(() => {
  start()
})
```

Effects go in `app/effects/`.

## Next.js

```ts
// next.config.ts
import { withDiorama } from 'diorama/next'

export default withDiorama({})
```

```tsx
// app/diorama.tsx
'use client'
import { start } from 'diorama'
import { useEffect } from 'react'

export function Diorama() {
  useEffect(() => void start(), [])
  return null
}
```

Render `<Diorama />` once in the root layout. `withDiorama` writes the effect registry to `src/diorama.gen.ts`; commit it.

## Without a build step

```html
<script type="module" src="https://cdn.jsdelivr.net/npm/diorama/dist/cdn/auto.js"></script>

<img src="/photo.jpg" alt="" data-dio="ripple" />
```

The app starts on its own and loads three.js after the first paint. If the page has GSAP from a CDN, it is used. Options go in `window.diorama` before the script tag:

```html
<script>
  window.diorama = { canvas: 'behind', effects: { glow: () => import('/fx/glow.js') } }
</script>
```

Your own effects import from the same URL so the page has a single instance:

```js
// /fx/glow.js
import { effect } from 'https://cdn.jsdelivr.net/npm/diorama/dist/cdn/auto.js'

export default effect({ amount: 1 }, ({ surface, u }) => {
  surface.color((color) => color.mul(u.amount.add(1)))
})
```

Set `window.diorama = { manual: true }` to call `start()` yourself.

## Types in CI

```bash
npx diorama gen           # writes src/diorama.gen.d.ts
npx diorama gen --check   # fails if the file is out of date
```

## Packages

| Package                | Contents                                                     |
| ---------------------- | ------------------------------------------------------------ |
| `diorama`              | `start()`, `effect()`, build integrations, CDN build, CLI    |
| `@diorama/core`        | App, plugins, signals, frame loop, stage, scroll, pointer    |
| `@diorama/render`      | WebGPU renderer with the WebGL 2 fallback                    |
| `@diorama/effects`     | Effects on DOM elements and their runtime                    |
| `@diorama/media`       | Image effects: `image`, `ripple`, `bend`                     |
| `@diorama/transitions` | Page transitions                                             |
| `@diorama/assets`      | Asset loading, cache and preload; glTF, Draco, Meshopt, KTX2 |
| `@diorama/gsap`        | GSAP and ScrollTrigger                                       |
| `@diorama/lenis`       | Lenis                                                        |
| `@diorama/glsl`        | GLSL to TSL converter, Vite plugin, webpack loader, CLI      |

Most sites only need `diorama`.

## Building

Node.js 22.12+ or 24+ and pnpm.

```bash
pnpm install
pnpm build
```

## License

MIT
