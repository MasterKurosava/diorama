// The effects of the module with their descriptions, for the meta test and the docs site.
// The light entry and the effect chunks never import it.
import type { Effect, EffectDoc, ParamSpec } from '@dioramajs/effects'
import assemble from './assemble'
import assembleDoc from './assemble.doc'
import blinds from './blinds'
import blindsDoc from './blinds.doc'
import counter from './counter'
import counterDoc from './counter.doc'
import dust from './dust'
import dustDoc from './dust.doc'
import emboss from './emboss'
import embossDoc from './emboss.doc'
import extrude from './extrude'
import extrudeDoc from './extrude.doc'
import fire from './fire'
import fireDoc from './fire.doc'
import hologram from './hologram'
import hologramDoc from './hologram.doc'
import inflate from './inflate'
import inflateDoc from './inflate.doc'
import keycaps from './keycaps'
import keycapsDoc from './keycaps.doc'
import lens from './lens'
import lensDoc from './lens.doc'
import magnet from './magnet'
import magnetDoc from './magnet.doc'
import marquee from './marquee'
import marqueeDoc from './marquee.doc'
import melt from './melt'
import meltDoc from './melt.doc'
import neon from './neon'
import neonDoc from './neon.doc'
import orbit from './orbit'
import orbitDoc from './orbit.doc'
import physics from './physics'
import physicsDoc from './physics.doc'
import pins from './pins'
import pinsDoc from './pins.doc'
import prism from './prism'
import prismDoc from './prism.doc'
import ribbon from './ribbon'
import ribbonDoc from './ribbon.doc'
import rotator from './rotator'
import rotatorDoc from './rotator.doc'
import scramble from './scramble'
import scrambleDoc from './scramble.doc'
import shatter from './shatter'
import shatterDoc from './shatter.doc'
import shimmer from './shimmer'
import shimmerDoc from './shimmer.doc'
import smoke from './smoke'
import smokeDoc from './smoke.doc'
import splitFlap from './split-flap'
import splitFlapDoc from './split-flap.doc'
import textGlitch from './text-glitch'
import textGlitchDoc from './text-glitch.doc'
import textReveal from './text-reveal'
import textRevealDoc from './text-reveal.doc'
import tunnel from './tunnel'
import tunnelDoc from './tunnel.doc'
import unfold from './unfold'
import unfoldDoc from './unfold.doc'
import videoText from './video-text'
import videoTextDoc from './video-text.doc'
import voxel from './voxel'
import voxelDoc from './voxel.doc'
import water from './water'
import waterDoc from './water.doc'
import wave from './wave'
import waveDoc from './wave.doc'

/** An effect with its description. */
export interface Documented {
  readonly name: string
  // biome-ignore lint/suspicious/noExplicitAny: any effect, whatever its params
  readonly effect: Effect<any>
  readonly doc: EffectDoc<Effect<ParamSpec>>
}

export const docs: readonly Documented[] = [
  { name: 'text-reveal', effect: textReveal, doc: textRevealDoc },
  { name: 'scramble', effect: scramble, doc: scrambleDoc },
  { name: 'marquee', effect: marquee, doc: marqueeDoc },
  { name: 'video-text', effect: videoText, doc: videoTextDoc },
  { name: 'wave', effect: wave, doc: waveDoc },
  { name: 'split-flap', effect: splitFlap, doc: splitFlapDoc },
  { name: 'counter', effect: counter, doc: counterDoc },
  { name: 'magnet', effect: magnet, doc: magnetDoc },
  { name: 'text-glitch', effect: textGlitch, doc: textGlitchDoc },
  { name: 'neon', effect: neon, doc: neonDoc },
  { name: 'assemble', effect: assemble, doc: assembleDoc },
  { name: 'dust', effect: dust, doc: dustDoc },
  { name: 'extrude', effect: extrude, doc: extrudeDoc },
  { name: 'shimmer', effect: shimmer, doc: shimmerDoc },
  { name: 'rotator', effect: rotator, doc: rotatorDoc },
  { name: 'inflate', effect: inflate, doc: inflateDoc },
  { name: 'ribbon', effect: ribbon, doc: ribbonDoc },
  { name: 'orbit', effect: orbit, doc: orbitDoc },
  { name: 'voxel', effect: voxel, doc: voxelDoc },
  { name: 'shatter', effect: shatter, doc: shatterDoc },
  { name: 'tunnel', effect: tunnel, doc: tunnelDoc },
  { name: 'emboss', effect: emboss, doc: embossDoc },
  { name: 'pins', effect: pins, doc: pinsDoc },
  { name: 'melt', effect: melt, doc: meltDoc },
  { name: 'unfold', effect: unfold, doc: unfoldDoc },
  { name: 'blinds', effect: blinds, doc: blindsDoc },
  { name: 'keycaps', effect: keycaps, doc: keycapsDoc },
  { name: 'lens', effect: lens, doc: lensDoc },
  { name: 'water', effect: water, doc: waterDoc },
  { name: 'fire', effect: fire, doc: fireDoc },
  { name: 'physics', effect: physics, doc: physicsDoc },
  { name: 'smoke', effect: smoke, doc: smokeDoc },
  { name: 'prism', effect: prism, doc: prismDoc },
  { name: 'hologram', effect: hologram, doc: hologramDoc },
]
