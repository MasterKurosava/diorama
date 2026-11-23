# Changelog

All packages share one version.

## 0.1.2

- Phones: copies keep to their elements while the page scrolls. The canvas is as tall as the large viewport (`100lvh`), so it no longer stretches when the browser toolbar slides away, and a pinned sticky stage stops and releases the canvas on the compositor exactly where CSS sticky does.
- `data-dio-when` and `data-dio-<effect>-when` run an element's effects under a media query and beat the effect's own `when`, so `all` keeps a hover effect on for touch screens on one element. `attach()` takes a `when` option too.
- `stage.pin(spans)`: scroll spans over which the canvas stands still on the compositor.

## 0.1.1

- The site package is `@dioramajs/diorama`: `npm i @dioramajs/diorama three`. Its command line stays `npx dioramajs`.
- `drops`: `lifetime`, the seconds a drop lasts at most, running or at rest, fading out over the last third of them.
- `frost`: a pane with no ice ignores the pointer, so moving it over bare glass draws nothing; a thaw down to bare glass clears what was wiped.
- READMEs on npm point at the new package name.

## 0.1.0

The first public release.

- `start()` and `data-dio`: effects on any element, kept in step with layout and scroll, drawn with WebGPU or WebGL 2 and only while something changes.
- `effect()` and the effects folder: your own effects as files, typed in `app.attach()`, with `kit` helpers and `npx dioramajs add` to copy a built-in.
- 100 effects for images and video, text, 3D objects, backgrounds, data, particles, cards and audio.
- Page transitions: keyed elements fly between pages, and page covers (`curtain`, `ink`, `pixel`) hide the swap on any router.
- Integrations for Vite, Astro, Nuxt and Next.js, and a CDN build for pages without a build step.
- GSAP, ScrollTrigger and Lenis in step with the canvas.
- `@dioramajs/glsl`: GLSL fragment shaders converted to TSL at build time.
- Adaptive quality tiers, reduced motion per effect, and plain HTML when the device has no GPU path.
