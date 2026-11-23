// The frame pipeline of the runtime, as four kernel systems: `effects:inputs` reads the DOM in
// layout, `effects:update` runs the effects' updates and decides on the next frame,
// `effects:compose` places layers before the draw, `effects:present` derives `drawn` after it.
import type { FrameTime, Off } from '@dioramajs/core'
import type { Group, Mesh, Object3D, UniformNode } from 'three/webgpu'
import { DEV } from '../define'
import { EffectError } from '../errors'
import type { Box } from '../types'
import { ADRIFT_FADE, ADRIFT_MAX, bursts, flying } from './adrift'
import type { FrameInputs, Rect } from './inputs'
import type { Inst, Phase } from './instance'
import type { LayerImpl } from './layer'
import { Presenter } from './present'
import { marked } from './sections'
import { sameStacking, stackingOf } from './stacking'
import { Watcher } from './watch'
import type { World } from './world'

/** 3000 px/s of scroll is velocity 1. */
const FULL_SPEED = 3000
/** renderOrder offset of overlay groups, above every `above` level of copies. */
export const OVERLAY = 1e9
/** Half a 60 Hz frame (ms): a time frame due this soon is requested at once, not by a timer. */
const EARLY = 8
/** How early an `fps` timer fires: one 60 Hz refresh, less half of EARLY, in ms. */
const LEAD = 1000 / 60 - EARLY / 2
/** Longest time step of a frame woken by an `fps` timer, in seconds. */
const MAX_STEP = 0.25

/** The viewport size and scroll offset of this frame. */
interface View {
  readonly width: number
  readonly height: number
  readonly scrollX: number
  readonly scrollY: number
}

export class Frame {
  readonly #world: World
  readonly #presenter: Presenter
  readonly #watcher: Watcher
  readonly #later: (() => void)[] = []
  /** Phases that took `u.velocity`. While any lives, scroll velocity is read every frame. */
  readonly #speeders = new Set<Phase>()
  readonly #inputs: FrameInputs
  /** Opacity per element for this frame, so siblings share their ancestors' reads. */
  readonly #opacities = new Map<Element, number>()
  /** Viewport box of a cached 'layout' clip, reused per layer. */
  readonly #clip = { left: 0, top: 0, right: 0, bottom: 0 }
  /** Overlay objects already raised. */
  readonly #raised = new WeakSet<Object3D>()
  /** Orphans whose burst landed in this frame, freed once it is drawn. */
  readonly #landed = new Set<LayerImpl>()
  /** Keeps the loop running while an effect asks for frames. */
  #hold: Off | undefined
  /** Earliest time frame due under `animate: { fps }`, in loop ms. */
  #due = Number.POSITIVE_INFINITY
  #timer: ReturnType<typeof setTimeout> | undefined
  /** This frame was woken by the `fps` timer, so time advances by the real interval. */
  #timed = false
  /** Between compose and present. Scene changes wait for `afterRender`. */
  #busy = false

  constructor(world: World) {
    this.#world = world
    const { app, scope } = world
    scope.system('layout', (time) => this.#layout(time), {
      name: 'effects:inputs',
      after: 'anchors',
    })
    scope.system('update', (time) => this.#update(time), { name: 'effects:update' })
    scope.system('render', () => this.#compose(), { name: 'effects:compose', before: 'render' })
    scope.system('afterRender', () => this.#present(), { name: 'effects:present' })
    this.#presenter = new Presenter({
      scope,
      layers: () => world.layers.values(),
      plugins: () => world.host.plugins(),
      invalidate: () => world.invalidate(),
      warn: (message) => app.log.warn(message),
    })
    this.#watcher = new Watcher(
      () => world.layers.values(),
      () => world.invalidate(),
      scope.abortSignal,
    )
    this.#inputs = {
      delta: 0,
      reduced: false,
      velocity: () => this.#scrollVelocity(),
      pointer: app.pointer.state,
      wake: () => world.invalidate(),
      toWorld: world.render.toWorld,
      opacities: this.#opacities,
    }
  }

  /** Runs a scene change now, or after the render stage if one is in progress. */
  later(task: () => void): void {
    if (this.#busy) this.#later.push(task)
    else task()
  }

  /** Shared `u.velocity`. Scroll velocity is read every frame while the phase lives. */
  velocity(phase: Phase): UniformNode<'float'> {
    if (phase.state !== 'closed' && !this.#speeders.has(phase)) {
      this.#speeders.add(phase)
      phase.offs.push(() => this.#speeders.delete(phase))
    }
    return this.#world.velocity
  }

  /** Runs deferred scene changes at once and stops holding frames. */
  dispose(): void {
    this.#busy = false
    for (const task of this.#later.splice(0)) task()
    this.#landed.clear()
    this.#hold = undefined
    clearTimeout(this.#timer)
  }

  /**
   * Scroll velocity in -1..1, 0 under reduced motion. Read only when something consumes it
   * (`u.velocity`, `input.velocity`), because reading it keeps frames coming while it decays.
   */
  #scrollVelocity(): number {
    const { app } = this.#world
    if (app.stage.reducedMotion.peek()) return 0
    return Math.min(1, Math.max(-1, app.scroll.state.velocity / FULL_SPEED))
  }

  // effects:inputs

  /** DOM reads only: boxes, styles of re-measured layers, visibility, inputs. */
  #layout(time: FrameTime): void {
    const world = this.#world
    const { stage, scroll } = world.app
    const reduced = stage.reducedMotion.peek()
    if (this.#speeders.size) world.velocity.value = this.#scrollVelocity()
    world.motion.value = reduced ? 0 : 1
    const view: View = {
      width: stage.width.peek(),
      height: stage.height.peek(),
      scrollX: scroll.state.x,
      scrollY: scroll.state.y,
    }
    world.sections.measure(view.height, view.scrollY)
    const frame = this.#inputs
    // An fps timer wakes the loop after idle, and a wake frame gets one nominal step.
    frame.delta = this.#timed ? Math.min(time.rawDelta, MAX_STEP) : time.delta
    this.#timed = false
    frame.reduced = reduced
    this.#opacities.clear()
    // Deleting from a Map while iterating is safe, and nothing adds layers here.
    for (const layer of world.layers.values()) this.#layoutLayer(layer, view, time.now)
    for (const layer of world.copies.ghosts) this.#layoutGhost(layer, view)
    for (const layer of [...world.orphans]) this.#layoutOrphan(layer, view, time.now)
  }

  /** A layer of an element in the document. */
  #layoutLayer(layer: LayerImpl, view: View, now: number): void {
    const world = this.#world
    const { element, anchor } = layer
    // Safety net for what the observer misses (shadow roots, adoptNode).
    if (!element.isConnected) {
      world.host.check(element)
      return
    }
    // Read the box before a re-measure. A track switch re-creates the anchor, which has no box
    // until the next anchors pass, so this frame keeps the previous one. A taken copy's box
    // replaces it, and then styles are not re-read and the clip stays.
    const copy = layer.taken
    const box = copy?.box
    const input = layer.inputs.input
    const held = box ? undefined : this.#adrift(layer, anchor, now)
    const sized = this.#box(layer, held ?? box ?? anchor, view) && !held
    const visible = input.visible || layer.posed > 0
    // A zero box shows the DOM at once, which is the fallback when the element shows again.
    if (!sized && layer.state === 'drawn') {
      layer.present(layer.running() ? 'live' : undefined)
      world.invalidate()
    }
    if (visible && !layer.visible) this.#watcher.wake()
    layer.visible = visible
    input.visible = visible
    // An off-screen layer keeps its re-measure pending until it shows.
    if (!visible) return
    // A theme switch changes `var()` colours without a write.
    for (const inst of layer.insts) {
      inst.current?.restyle()
      inst.next?.restyle()
    }
    if (held) {
      this.#fit(layer, input.width, input.height)
      layer.inputs.compute(this.#inputs, input.progress, input.pin, false, copy, true)
      return
    }
    if (!box && anchor.version !== layer.version) this.#measure(layer, view)
    this.#fit(layer, input.width, input.height)
    // A held box keeps the clip as last read. The copy's `clip` overrides either.
    const clip = box ? false : this.#clipBox(layer, view)
    // A section anchor made this frame has no box until the next anchors pass: keep the last.
    const { section } = layer
    const scrolled = section ? (section.version ? section : input) : anchor
    const pin = this.#pin(element, scrolled.pin)
    layer.inputs.compute(this.#inputs, scrolled.progress, pin, clip, copy)
  }

  /** The viewport box of the clipping ancestor: cached for 'layout' tracking, else read now. */
  #clipBox(layer: LayerImpl, view: View): Rect | undefined {
    const cached = layer.clip
    if (!cached) return layer.inputs.styles.clip?.getBoundingClientRect()
    const clip = this.#clip
    clip.left = cached.left - view.scrollX
    clip.top = cached.top - view.scrollY
    clip.right = cached.right - view.scrollX
    clip.bottom = cached.bottom - view.scrollY
    return clip
  }

  /**
   * Ghosts have no DOM, anchor or styles, so they use the owner's box or the frozen one. The clip
   * stays as last read: an open one would bleed out of the old container on the first frame of a
   * flight.
   */
  #layoutGhost(layer: LayerImpl, view: View): void {
    const input = layer.inputs.input
    const copy = layer.taken
    this.#box(layer, copy?.box ?? (layer.rest as Box), view)
    layer.visible = input.visible
    if (!input.visible) return
    this.#fit(layer, input.width, input.height)
    layer.inputs.compute(this.#inputs, input.progress, input.pin, false, copy, true)
  }

  /** Orphans fly on from the element's last box and fade out when the page leaves. */
  #layoutOrphan(layer: LayerImpl, view: View, now: number): void {
    const adrift = layer.adrift as NonNullable<LayerImpl['adrift']>
    if (Number.isNaN(adrift.leave)) adrift.leave = now
    const presence = adrift.leave === Infinity ? 1 : 1 - (now - adrift.leave) / ADRIFT_FADE
    const input = layer.inputs.input
    this.#box(layer, adrift.box, view)
    layer.visible = input.visible
    const expired = now - adrift.since >= ADRIFT_MAX
    if (!input.visible || presence <= 0 || expired || !flying(layer)) {
      this.#world.bury(layer)
      return
    }
    this.#fit(layer, input.width, input.height)
    const taken = {
      box: undefined,
      radius: undefined,
      clip: undefined,
      opacity: 1,
      presence,
      fade: layer.fades(),
    }
    layer.inputs.compute(this.#inputs, input.progress, input.pin, false, taken, true)
  }

  /**
   * A connected element's zero box: while a burst of it flies in the overlay, the box it had
   * before, for at most ADRIFT_MAX. Undefined otherwise.
   */
  #adrift(layer: LayerImpl, own: Box, now: number): Box | undefined {
    if (own.width > 0 && own.height > 0) {
      layer.adrift = undefined
      return undefined
    }
    const { adrift } = layer
    if (!adrift) {
      const { x, y, width, height } = layer.input
      if (!layer.visible || !(width > 0 && height > 0) || !flying(layer)) return undefined
      layer.adrift = { box: { x, y, width, height }, since: now, leave: Infinity }
      return layer.adrift.box
    }
    if (now - adrift.since < ADRIFT_MAX && flying(layer)) return adrift.box
    layer.adrift = undefined
    return undefined
  }

  /** The media's object-fit and `zoom` as a UV transform, or the region a taken copy's owner set. */
  #fit(layer: LayerImpl, width: number, height: number): void {
    const { crop } = layer.inputs
    const owned = layer.taken?.crop
    if (owned) crop.splice(0, 4, owned.width, owned.height, owned.x, owned.y)
    else if (layer.media) {
      layer.media.fit(layer.inputs.styles, width, height, crop)
      layer.surface?.frame(crop)
    }
    for (const inst of layer.insts) {
      for (const phase of [inst.current, inst.next]) {
        for (const fit of phase?.fits ?? []) fit.update(width, height)
      }
    }
  }

  /** Writes the box and its visibility (with bleed) into the input. Returns true if sized. */
  #box(layer: LayerImpl, box: Box, view: View): boolean {
    const input = layer.inputs.input
    input.x = box.x
    input.y = box.y
    input.width = box.width
    input.height = box.height
    const bleed = layer.bleed()
    const sized = input.width > 0 && input.height > 0
    input.visible =
      sized &&
      input.y - bleed < view.height &&
      input.y + input.height + bleed > 0 &&
      input.x - bleed < view.width &&
      input.x + input.width + bleed > 0
    return sized
  }

  /** The `app.effects.pin` source. Falls back to the anchor if it throws or is not finite. */
  #pin(element: Element, fallback: number): number {
    const { host } = this.#world
    const source = host.pin(element)
    if (!source) return fallback
    let value: unknown
    try {
      value = source()
    } catch (cause) {
      const message = `the effects.pin source threw: ${String(cause)}`
      host.warn('pin', new EffectError('EFFECT_PARAM', message, { element, cause }))
    }
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback
  }

  /** Styles, the track mode and a 'layout' clip box follow `anchor.version`. */
  #measure(layer: LayerImpl, view: View): void {
    const { app, host, sections } = this.#world
    const { element } = layer
    const mode = host.track(element)
    if ((mode === 'layout') !== (layer.mode === 'layout')) {
      layer.anchor.dispose()
      layer.anchor = app.anchors.track(element, { live: mode !== 'layout' })
    }
    layer.mode = mode
    layer.section = sections.swap(layer.section, marked(element))
    const { styles } = layer.inputs
    styles.read(element, (key, message) => {
      if (DEV) host.warn(key, new EffectError('EFFECT_TARGET', message, { element }))
    })
    // Like the anchor, a 'layout' layer caches its clip box in page px, offset by the scroll.
    const box = mode === 'layout' ? styles.clip?.getBoundingClientRect() : undefined
    layer.clip = box && {
      left: box.left + view.scrollX,
      top: box.top + view.scrollY,
      right: box.right + view.scrollX,
      bottom: box.bottom + view.scrollY,
    }
    const stacking = stackingOf(element)
    if (!sameStacking(stacking, layer.stacking)) {
      layer.stacking = stacking
      this.#world.restack()
    }
    layer.version = layer.anchor.version
  }

  // effects:update

  /** Runs updates in document and effect order, then decides on the next frame. */
  #update(time: FrameTime): void {
    const world = this.#world
    let wanted = false
    const reduced = world.app.stage.reducedMotion.peek()
    this.#due = Number.POSITIVE_INFINITY
    world.updating = true
    try {
      // Both arrays are replaced, never spliced, when layers or instances go, so no copies needed.
      for (const layer of world.ordered()) wanted = this.#tick(layer, time, reduced) || wanted
      // Ghosts update too, so particles fly on while they fade.
      for (const layer of [...world.copies.ghosts]) {
        wanted = this.#tick(layer, time, reduced) || wanted
      }
      for (const layer of [...world.orphans]) {
        wanted = this.#tick(layer, time, reduced) || wanted
        if (world.orphans.has(layer) && !flying(layer)) this.#landed.add(layer)
      }
    } finally {
      world.updating = false
    }
    if (this.#scheduleTimeFrame(this.#due - time.now)) wanted = true
    this.#holdFrames(wanted)
  }

  /**
   * The next `fps` time frame. Due within EARLY, it is wanted now (returns true). Later, a timer
   * asks for it within the refresh before: a frame a timer asks for runs at the next display
   * refresh, so fired at the due time it would land one refresh late (30 fps drew 20 on 60 Hz).
   */
  #scheduleTimeFrame(wait: number): boolean {
    clearTimeout(this.#timer)
    this.#timer = undefined
    if (wait <= EARLY) return true
    if (!(wait < Number.POSITIVE_INFINITY)) return false
    this.#timer = setTimeout(
      () => {
        this.#timed = true
        this.#world.invalidate()
      },
      Math.max(0, wait - LEAD),
    )
    return false
  }

  /** The hold is taken and released in the frame that decides. */
  #holdFrames(wanted: boolean): void {
    if (wanted && !this.#hold) this.#hold = this.#world.scope.hold('effects')
    else if (!wanted && this.#hold) {
      this.#hold()
      this.#hold = undefined
    }
  }

  /** Updates one visible layer. Returns true to ask for the next frame. */
  #tick(layer: LayerImpl, time: FrameTime, reduced: boolean): boolean {
    if (!layer.visible) return false
    const world = this.#world
    let wanted = layer.inputs.easing || layer.inputs.fading
    const ghost = world.copies.ghosts.has(layer)
    const { adrift } = layer
    for (const inst of layer.insts) {
      if (!inst.live) continue
      if (!ghost && !adrift && inst.rebuild && !inst.parked && inst.current) {
        world.phases.rebuild(inst)
      }
      const phase = inst.current
      if (phase?.state !== 'active' || inst.parked) continue
      // Without its box, a layer runs only its bursts.
      if (adrift && !bursts(phase)) continue
      try {
        wanted = this.#runUpdate(layer, phase, time, reduced) || wanted
      } catch (cause) {
        if (!this.#updateFailed(layer, inst, ghost, cause)) return wanted
      }
    }
    return wanted
  }

  /** Runs the phase's update and applies its frame policy. Returns true to ask for a frame. */
  #runUpdate(layer: LayerImpl, phase: Phase, time: FrameTime, reduced: boolean): boolean {
    const input = layer.inputs.input
    input.clock = false
    input.hoverClock = false
    const answer = phase.update?.(layer.input, time)
    phase.more = answer === true
    if (typeof answer === 'boolean') phase.answers = true
    if (input.clock) phase.clock = true
    if (input.hoverClock) phase.hoverClock = true
    const declared = phase.def.animate
    // Without a declared policy, a boolean from the update decides, else the clocks it read.
    if (declared === undefined && typeof answer === 'boolean') return answer
    const animate = declared ?? (phase.clock ? 'visible' : phase.hoverClock ? 'hover' : 'input')
    return this.#policy(phase, animate, input, time, reduced) || phase.more
  }

  /** Whether a frame policy asks for the next frame. */
  #policy(
    phase: Phase,
    animate: NonNullable<Phase['def']['animate']>,
    input: LayerImpl['inputs']['input'],
    time: FrameTime,
    reduced: boolean,
  ): boolean {
    if (typeof animate === 'function') return animate(phase.ctx as never) === true
    if (typeof animate === 'object') {
      if (!reduced) this.#rate(phase, animate, time.now)
      return false
    }
    if (animate === 'visible') return !reduced
    if (animate === 'hover') {
      input.point()
      return !reduced && (input.isOver || input.damped > 0)
    }
    return false
  }

  /**
   * An update threw. A running instance fails; a ghost or orphan goes, since its record may live
   * a new life on a returned node. Returns false when the layer is gone and the tick must stop.
   */
  #updateFailed(layer: LayerImpl, inst: Inst, ghost: boolean, cause: unknown): boolean {
    const world = this.#world
    // An EffectError keeps its own code (EFFECT_CORS found after setup), as from setup.
    const error =
      cause instanceof EffectError
        ? cause
        : new EffectError('EFFECT_UPDATE', cause instanceof Error ? cause.message : String(cause), {
            effect: inst.rec.name,
            element: inst.rec.element,
            cause,
          })
    if (world.orphans.has(layer)) {
      if (DEV) world.host.warn('orphan', error)
      world.bury(layer)
      return false
    }
    if (ghost) {
      world.copies.fault(layer, error)
      return false
    }
    world.host.fail(inst.rec, error)
    return true
  }

  /**
   * `animate: { fps }`: this frame counts as a time frame if the period has passed, and the next
   * one is due a period later. Input frames in between run at full rate.
   */
  #rate(phase: Phase, policy: { readonly fps: unknown }, now: number): void {
    const read = policy.fps
    const fps =
      typeof read === 'function' ? (read as (ctx: unknown) => number)(phase.ctx) : (read as number)
    if (!(fps > 0)) return
    const period = 1000 / fps
    // A frame up to LEAD early counts, since the timer fires that early. Due times keep to a grid,
    // so early and late frames average out to `fps`.
    const since = now - phase.stamp
    if (since >= period - LEAD) phase.stamp = since < 2 * period ? phase.stamp + period : now
    this.#due = Math.min(this.#due, phase.stamp + period)
  }

  // effects:compose

  /** Layout plus pose, visibility, material and rebuild swaps. */
  #compose(): void {
    const world = this.#world
    this.#presenter.sync()
    world.phases.swap()
    let over = false
    for (const layers of [world.layers.values(), world.copies.ghosts, world.orphans]) {
      for (const layer of layers) {
        this.#arrange(layer)
        over ||= !!layer.taken?.above && layer.root.visible
      }
    }
    world.over(over)
    const { ghosts } = world.copies
    world.painter?.rank(
      world.orphans.size ? [...ghosts, ...world.orphans] : ghosts,
      world.painted(),
    )
    this.#busy = true
  }

  /** One layer in compose: its place, a taken copy's veil and order, viewports, surface. */
  #arrange(layer: LayerImpl): void {
    layer.place(this.#world.render.toWorld)
    const veiled = !!layer.taken?.veil
    // Without its box only the bursts in the overlay draw.
    const { adrift } = layer
    if (veiled || adrift) layer.root.visible = false
    // A pose of another size reframes the media and the masks instead of stretching them. A zoom
    // set in this frame's updates shows in this frame.
    if (layer.posed > 0 || layer.surface?.zoomed) {
      this.#fit(layer, layer.width, layer.height)
      layer.inputs.resize(layer.width, layer.height)
    }
    for (const inst of layer.insts) {
      for (const phase of [inst.current, inst.next]) {
        const shown = !!phase?.shown && layer.visible && !veiled
        if (phase?.viewport) phase.viewport.visible = shown && !adrift
        if (phase?.overlay) {
          phase.overlay.visible = shown && (!adrift || bursts(phase))
          this.#raise(phase.overlay)
        }
      }
    }
    const surface = layer.surface
    if (!surface) return
    surface.compose()
    if (layer.surface) surface.mesh.visible = surface.drawable
  }

  /** Overlay content draws after everything else and ignores depth. */
  #raise(root: Group): void {
    root.traverse((object) => {
      if (this.#raised.has(object)) return
      this.#raised.add(object)
      object.renderOrder += OVERLAY
      for (const material of [(object as Mesh).material ?? []].flat()) {
        material.depthTest = false
        material.depthWrite = false
      }
    })
  }

  // effects:present

  /** Updates the drawn state from this frame, then runs deferred releases. */
  #present(): void {
    this.#busy = false
    this.#presenter.frame()
    for (const layer of this.#world.layers.values()) if (layer.state === 'drawn') layer.snapshot()
    this.#world.copies.present()
    for (const task of this.#later.splice(0)) task()
    for (const layer of this.#landed) this.#world.bury(layer)
    this.#landed.clear()
  }
}
