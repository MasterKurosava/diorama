// Every effect of the module with its description, for the meta test and the docs site.
// The light entry and the effect chunks never import it.
import type { Effect, EffectDoc, ParamSpec } from '@dioramajs/effects'
import ambient from './ambient'
import ambientDoc from './ambient.doc'
import bend from './bend'
import bendDoc from './bend.doc'
import carousel from './carousel'
import carouselDoc from './carousel.doc'
import chroma from './chroma'
import chromaDoc from './chroma.doc'
import compare from './compare'
import compareDoc from './compare.doc'
import coverflow from './coverflow'
import coverflowDoc from './coverflow.doc'
import curtain from './curtain'
import curtainDoc from './curtain.doc'
import expand from './expand'
import expandDoc from './expand.doc'
import flare from './flare'
import flareDoc from './flare.doc'
import flipbook from './flipbook'
import flipbookDoc from './flipbook.doc'
import frost from './frost'
import frostDoc from './frost.doc'
import gallery from './gallery'
import galleryDoc from './gallery.doc'
import glitch from './glitch'
import glitchDoc from './glitch.doc'
import horizontal from './horizontal'
import horizontalDoc from './horizontal.doc'
import hoverPreview from './hover-preview'
import hoverPreviewDoc from './hover-preview.doc'
import image from './image'
import imageDoc from './image.doc'
import lightbox from './lightbox'
import lightboxDoc from './lightbox.doc'
import liquid from './liquid'
import liquidDoc from './liquid.doc'
import panorama from './panorama'
import panoramaDoc from './panorama.doc'
import parallax from './parallax'
import parallaxDoc from './parallax.doc'
import pixelate from './pixelate'
import pixelateDoc from './pixelate.doc'
import polaroids from './polaroids'
import polaroidsDoc from './polaroids.doc'
import reflection from './reflection'
import reflectionDoc from './reflection.doc'
import reveal from './reveal'
import revealDoc from './reveal.doc'
import ripple from './ripple'
import rippleDoc from './ripple.doc'
import scrub from './scrub'
import scrubDoc from './scrub.doc'
import sequence from './sequence'
import sequenceDoc from './sequence.doc'
import spin from './spin'
import spinDoc from './spin.doc'
import spotlight from './spotlight'
import spotlightDoc from './spotlight.doc'
import stack from './stack'
import stackDoc from './stack.doc'
import tilt from './tilt'
import tiltDoc from './tilt.doc'
import tone from './tone'
import toneDoc from './tone.doc'
import videoHover from './video-hover'
import videoHoverDoc from './video-hover.doc'
import zoom from './zoom'
import zoomDoc from './zoom.doc'
import zoomScroll from './zoom-scroll'
import zoomScrollDoc from './zoom-scroll.doc'

/** An effect with its description. */
export interface Documented {
  readonly name: string
  // biome-ignore lint/suspicious/noExplicitAny: any effect, whatever its params
  readonly effect: Effect<any>
  readonly doc: EffectDoc<Effect<ParamSpec>>
}

export const docs: readonly Documented[] = [
  { name: 'image', effect: image, doc: imageDoc },
  { name: 'ripple', effect: ripple, doc: rippleDoc },
  { name: 'bend', effect: bend, doc: bendDoc },
  { name: 'reveal', effect: reveal, doc: revealDoc },
  { name: 'parallax', effect: parallax, doc: parallaxDoc },
  { name: 'gallery', effect: gallery, doc: galleryDoc },
  { name: 'ambient', effect: ambient, doc: ambientDoc },
  { name: 'hover-preview', effect: hoverPreview, doc: hoverPreviewDoc },
  { name: 'sequence', effect: sequence, doc: sequenceDoc },
  { name: 'expand', effect: expand, doc: expandDoc },
  { name: 'zoom-scroll', effect: zoomScroll, doc: zoomScrollDoc },
  { name: 'compare', effect: compare, doc: compareDoc },
  { name: 'zoom', effect: zoom, doc: zoomDoc },
  { name: 'lightbox', effect: lightbox, doc: lightboxDoc },
  { name: 'panorama', effect: panorama, doc: panoramaDoc },
  { name: 'tilt', effect: tilt, doc: tiltDoc },
  { name: 'tone', effect: tone, doc: toneDoc },
  { name: 'flipbook', effect: flipbook, doc: flipbookDoc },
  { name: 'spin', effect: spin, doc: spinDoc },
  { name: 'glitch', effect: glitch, doc: glitchDoc },
  { name: 'pixelate', effect: pixelate, doc: pixelateDoc },
  { name: 'video-hover', effect: videoHover, doc: videoHoverDoc },
  { name: 'stack', effect: stack, doc: stackDoc },
  { name: 'coverflow', effect: coverflow, doc: coverflowDoc },
  { name: 'carousel', effect: carousel, doc: carouselDoc },
  { name: 'polaroids', effect: polaroids, doc: polaroidsDoc },
  { name: 'spotlight', effect: spotlight, doc: spotlightDoc },
  { name: 'scrub', effect: scrub, doc: scrubDoc },
  { name: 'chroma', effect: chroma, doc: chromaDoc },
  { name: 'liquid', effect: liquid, doc: liquidDoc },
  { name: 'horizontal', effect: horizontal, doc: horizontalDoc },
  { name: 'curtain', effect: curtain, doc: curtainDoc },
  { name: 'flare', effect: flare, doc: flareDoc },
  { name: 'frost', effect: frost, doc: frostDoc },
  { name: 'reflection', effect: reflection, doc: reflectionDoc },
]
