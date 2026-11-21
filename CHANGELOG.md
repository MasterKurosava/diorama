# Changelog

All packages share one version.

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
