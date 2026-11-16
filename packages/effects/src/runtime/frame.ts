import type { FrameTime, Off } from '@diorama/core'
import type { UniformNode } from 'three/webgpu'
import { DEV } from '../define'
import { EffectError } from '../errors'
import type { Box } from '../types'
import type { FrameInputs, Rect } from './inputs'
import type { Phase } from './instance'
import type { LayerImpl } from './layer'
import { Presenter } from './present'
import { Watcher } from './watch'
import type { World } from './world'

/** 3000 px/s of scroll is velocity 1. */
const FULL_SPEED = 3000

/** Frame pipeline: inputs in layout, then updates, compose and present. */
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
  #hold: Off | undefined
  /** Between compose and present. Scene changes wait for `afterRender`. */
  #busy = false

  constructor(world: World) {
    this.#world = world
    const { app, scope } = world
    scope.system('layout', (t) => this.#layout(t), { name: 'effects:inputs', after: 'anchors' })
    scope.system('update', (t) => this.#update(t), { name: 'effects:update' })
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
    this.#hold = undefined
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

  /** `effects:inputs`. DOM reads only: boxes, styles of re-measured layers, visibility, inputs. */
  #layout(t: FrameTime): void {
    const world = this.#world
    const { stage, scroll } = world.app
    const reduced = stage.reducedMotion.peek()
    if (this.#speeders.size) world.velocity.value = this.#scrollVelocity()
    world.motion.value = reduced ? 0 : 1
    const vw = stage.width.peek()
    const vh = stage.height.peek()
    const { x: sx, y: sy } = scroll.state
    const frame = this.#inputs
    frame.delta = t.delta
    frame.reduced = reduced
    this.#opacities.clear()
    // Deleting from a Map while iterating is safe, and nothing adds layers here.
    for (const layer of world.layers.values()) {
      const el = layer.element
      // Safety net for what the observer misses (shadow roots, adoptNode).
      if (!el.isConnected) {
        world.host.check(el)
        continue
      }
      // Read the box before a re-measure. A track switch re-creates the anchor, which has no box
      // until the next anchors pass, so this frame keeps the previous one. A taken copy's box
      // replaces it, and then styles are not re-read and the clip stays.
      const { anchor } = layer
      const copy = layer.taken
      const box = copy?.box
      const i = layer.inputs.input
      const sized = this.#box(layer, box ?? anchor, vw, vh)
      const visible = i.visible || layer.posed > 0
      // A zero box shows the DOM at once, which is the fallback when the element shows again.
      if (!sized && layer.state === 'drawn') {
        layer.present(layer.running() ? 'live' : undefined)
        world.invalidate()
      }
      if (visible && !layer.visible) this.#watcher.wake()
      layer.visible = visible
      i.visible = visible
      // An off-screen layer keeps its re-measure pending until it shows.
      if (!visible) continue
      if (!box && anchor.version !== layer.version) this.#measure(layer, sx, sy)
      const { styles } = layer.inputs
      this.#fit(layer, i.width, i.height)
      const c = layer.clip
      // A held box keeps the clip as last read. The copy's `clip` overrides either.
      let clip: Rect | undefined | false = false
      if (!box && c) {
        clip = this.#clip
        this.#clip.left = c.left - sx
        this.#clip.top = c.top - sy
        this.#clip.right = c.right - sx
        this.#clip.bottom = c.bottom - sy
      } else if (!box) clip = styles.clip?.getBoundingClientRect()
      layer.inputs.compute(frame, anchor.progress, this.#pin(el, anchor.pin), clip, copy)
    }
    // Ghosts have no DOM, anchor or styles, so they use the owner's box or the frozen one. The
    // clip stays as last read: an open one would bleed out of the old container on the first
    // frame of a flight.
    for (const layer of world.copies.ghosts) {
      const i = layer.inputs.input
      const copy = layer.taken
      this.#box(layer, copy?.box ?? (layer.rest as Box), vw, vh)
      layer.visible = i.visible
      if (!i.visible) continue
      this.#fit(layer, i.width, i.height)
      layer.inputs.compute(frame, i.progress, i.pin, false, copy, true)
    }
  }

  /** The media's object-fit as a UV transform, or the region a taken copy's owner set. */
  #fit(layer: LayerImpl, width: number, height: number): void {
    const { crop } = layer.inputs
    const c = layer.taken?.crop
    if (c) crop.splice(0, 4, c.width, c.height, c.x, c.y)
    else layer.media?.fit(layer.inputs.styles, width, height, crop)
  }

  /** Writes the box and its visibility (with bleed) into the input. Returns true if sized. */
  #box(layer: LayerImpl, box: Box, vw: number, vh: number): boolean {
    const i = layer.inputs.input
    i.x = box.x
    i.y = box.y
    i.width = box.width
    i.height = box.height
    const b = layer.bleed()
    const sized = i.width > 0 && i.height > 0
    i.visible =
      sized && i.y - b < vh && i.y + i.height + b > 0 && i.x - b < vw && i.x + i.width + b > 0
    return sized
  }

  /** The `app.effects.pin` source. Falls back to the anchor if it throws or is not finite. */
  #pin(el: Element, fallback: number): number {
    const { host } = this.#world
    const source = host.pin(el)
    if (!source) return fallback
    let value: unknown
    try {
      value = source()
    } catch (cause) {
      const message = `the effects.pin source threw: ${String(cause)}`
      host.warn('pin', new EffectError('EFFECT_PARAM', message, { element: el, cause }))
    }
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback
  }

  /** Styles, the track mode and a 'layout' clip box follow `anchor.version`. */
  #measure(layer: LayerImpl, sx: number, sy: number): void {
    const { app, host } = this.#world
    const el = layer.element
    const mode = host.track(el)
    if ((mode === 'layout') !== (layer.mode === 'layout')) {
      layer.anchor.dispose()
      layer.anchor = app.anchors.track(el, { live: mode !== 'layout' })
    }
    layer.mode = mode
    const { styles } = layer.inputs
    styles.read(el, (key, message) => {
      if (DEV) host.warn(key, new EffectError('EFFECT_TARGET', message, { element: el }))
    })
    // Like the anchor, a 'layout' layer caches its clip box in page px, offset by the scroll.
    const box = mode === 'layout' ? styles.clip?.getBoundingClientRect() : undefined
    layer.clip = box && {
      left: box.left + sx,
      top: box.top + sy,
      right: box.right + sx,
      bottom: box.bottom + sy,
    }
    layer.version = layer.anchor.version
  }

  /** `effects:update`. Runs updates in document and effect order, then decides on the next frame. */
  #update(t: FrameTime): void {
    const world = this.#world
    let wanted = false
    const reduced = world.app.stage.reducedMotion.peek()
    // Both arrays are replaced, never spliced, when layers or instances go, so no copies needed.
    for (const layer of world.ordered()) wanted = this.#tick(layer, t, reduced) || wanted
    // Ghosts update too, so particles fly on while they fade.
    for (const layer of [...world.copies.ghosts]) wanted = this.#tick(layer, t, reduced) || wanted
    // The hold is taken and released in the frame that decides.
    if (wanted && !this.#hold) this.#hold = world.scope.hold('effects')
    else if (!wanted && this.#hold) {
      this.#hold()
      this.#hold = undefined
    }
  }

  /** Updates one visible layer. Returns true to ask for the next frame. */
  #tick(layer: LayerImpl, t: FrameTime, reduced: boolean): boolean {
    if (!layer.visible) return false
    const world = this.#world
    let wanted = layer.inputs.easing || layer.inputs.fading
    const ghost = world.copies.ghosts.has(layer)
    for (const inst of layer.insts) {
      if (!inst.live) continue
      if (!ghost && inst.rebuild && !inst.parked && inst.current) world.phases.rebuild(inst)
      const phase = inst.current
      if (phase?.state !== 'active' || inst.parked) continue
      try {
        const i = layer.inputs.input
        i.clock = false
        i.hoverClock = false
        phase.update?.(layer.input, t)
        if (i.clock) phase.clock = true
        if (i.hoverClock) phase.hoverClock = true
        const animate =
          phase.def.animate ?? (phase.clock ? 'visible' : phase.hoverClock ? 'hover' : 'input')
        if (typeof animate === 'function') wanted = animate(phase.ctx as never) === true || wanted
        else if (animate === 'visible') wanted ||= !reduced
        else if (animate === 'hover') wanted ||= !reduced && (i.over || i.damped > 0)
      } catch (cause) {
        const name = inst.rec.name
        const message = cause instanceof Error ? cause.message : String(cause)
        const error = new EffectError('EFFECT_UPDATE', message, {
          effect: name,
          element: inst.rec.element,
          cause,
        })
        // A ghost's record may live a new life on a returned node, so only the ghost goes.
        if (!ghost) world.host.fail(inst.rec, error)
        else {
          world.copies.fault(layer, error)
          return wanted
        }
      }
    }
    return wanted
  }

  /** `effects:compose`. Layout plus pose, visibility, material and rebuild swaps. */
  #compose(): void {
    const world = this.#world
    this.#presenter.sync()
    world.phases.swap()
    for (const layer of world.layers.values()) this.#arrange(layer)
    for (const layer of world.copies.ghosts) this.#arrange(layer)
    this.#busy = true
  }

  /** One layer in compose: its place, a taken copy's veil and order, viewports, surface. */
  #arrange(layer: LayerImpl): void {
    layer.place(this.#world.render.toWorld)
    const copy = layer.taken
    const veiled = !!copy?.veil
    if (veiled) layer.root.visible = false
    // A pose of another size reframes the media and the masks instead of stretching them.
    if (layer.posed > 0) {
      this.#fit(layer, layer.width, layer.height)
      layer.inputs.resize(layer.width, layer.height)
    }
    for (const inst of layer.insts) {
      for (const phase of [inst.current, inst.next]) {
        if (phase?.viewport) phase.viewport.visible = phase.shown && layer.visible && !veiled
      }
    }
    if (copy) this.#world.copies.lift(layer, copy)
    const surface = layer.surface
    if (!surface) return
    surface.compose()
    if (layer.surface) surface.mesh.visible = surface.drawable
  }

  /** `effects:present`. Updates the drawn state from this frame, then runs deferred releases. */
  #present(): void {
    this.#busy = false
    this.#presenter.frame()
    for (const layer of this.#world.layers.values()) if (layer.state === 'drawn') layer.snapshot()
    this.#world.copies.present()
    for (const task of this.#later.splice(0)) task()
  }
}
