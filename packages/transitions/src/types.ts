import type { Cleanup, Off, ReadonlySignal } from '@dioramajs/core'

/** Changes the DOM. May return a thenable that settles once the router is done. */
export type Swap = () => unknown
/** An easing function from 0..1 to 0..1. */
export type Ease = (t: number) => number

/** How copies fly between pages. */
export interface FlightOptions {
  /** Seconds. Default 0.8. */
  readonly duration: number
  /** Default cubic in-out. GSAP eases work too, e.g. `gsap.parseEase('expo.inOut')`. */
  readonly ease: Ease
  /** Seconds between flight starts, in document order of the targets. Default 0. */
  readonly stagger: number
  /** Seconds a landed copy fades over the target's own copy or DOM. Default 0.25. */
  readonly crossfade: number
  /** Seconds a landed copy waits for the target's copy before giving way to the DOM. Default 2. */
  readonly wait: number
}

/** How unpaired copies leave and new ones enter. */
export interface PresenceOptions {
  /**
   * Seconds unpaired copies outlive their removed elements, as u.presence goes from 1 to 0.
   * Default 0, or 0.25 inside a browser view transition. Under reduced motion the option is
   * ignored, the default applies and the copy's opacity fades instead.
   */
  readonly leave: number
  /**
   * Seconds new copies in view take to appear, as u.presence goes from 0 to 1. Their DOM waits
   * at most 0.5 s. Default 0, or 0.25 inside a browser view transition. Under reduced motion the
   * option is ignored, the default applies and the copy's opacity fades instead.
   */
  readonly enter: number
}

/** Options of one `app.transition` call. Unset fields take the plugin options. */
export interface TransitionOptions extends Partial<FlightOptions & PresenceOptions> {
  /**
   * Custom choreography, called when the flights start. Its result is awaited, so a GSAP timeline
   * works. `leaving` and `entering` are only filled when `leave` or `enter` is above 0 or inside a
   * browser view transition. Their durations then only matter if the transition is cut short.
   */
  readonly animate?: (transition: Transition) => unknown
  /** On abort everything lands at once and the status is 'aborted'. The swap still runs. */
  readonly signal?: AbortSignal
  /** Seconds to wait for a thenable swap or `animate` before giving up the flights. Default 10. */
  readonly timeout?: number
  /** URL of the new page for the page scope and events. Default `location.href` after the swap. */
  readonly url?: string | URL
  /**
   * The browser view transition the swap runs in, or null for none. When omitted, or when it is
   * a router's look-alike object, it is detected with `:active-view-transition`.
   */
  readonly viewTransition?: ViewTransition | null
}

/** Options of the `transitions` preset. */
export interface TransitionsOptions extends FlightOptions, PresenceOptions {
  /** Pair copies on DOM changes made without app.transition (React/Vue commits). Default true. */
  readonly auto: boolean
  /** Seconds an unpaired keyed copy waits, invisible, for a late partner. Default 1. */
  readonly grace: number
  /**
   * With 'hold' (default) a taken source keeps its snapshot box and opacity while the router
   * animates the old page out. With 'follow' it tracks its element until removal.
   */
  readonly sources: 'hold' | 'follow'
}

/** Phase of a transition: the swap runs, copies fly, or it is over. */
export type TransitionPhase = 'swapping' | 'flying' | 'done'
/** State of one flight. */
export type FlightState = 'flying' | 'holding' | 'crossfading' | 'leaving' | 'done'

/** Every write requests a frame, so it can be tweened directly. */
export interface Flight {
  /** The `data-dio-key` that paired the two elements. */
  readonly key: string
  /** The element that left (detached, or still in the DOM with Barba sync). */
  readonly from: Element
  /** The element that came in. */
  readonly to: Element
  /** Where the flight is now. */
  readonly state: FlightState
  /** 0 at the source box, 1 at the target box. Eased by `ease` unless `animate` drives it. */
  progress: number
  /** Alpha multiplier for the flying copy and the target copy taking over under it. Default 1. */
  opacity: number
}

/** An unpaired copy that leaves or a new copy that enters. */
export interface Presence {
  /** The element of the copy. */
  readonly element: Element
  /** u.presence of the copy, or its opacity under reduced motion. 0 is absent, 1 present. */
  presence: number
}

/** How a transition ended. */
export interface TransitionResult {
  /** How it ended. `superseded` means a newer transition took over. */
  readonly status: 'done' | 'superseded' | 'aborted' | 'failed' | 'skipped'
  /** Number of flights that landed. */
  readonly flights: number
  /** The swap error, for `failed`. */
  readonly error?: unknown
}

/** Thenable. Resolves with the result and never rejects. */
export interface Transition extends PromiseLike<TransitionResult> {
  /** Current phase. */
  readonly phase: ReadonlySignal<TransitionPhase>
  /** Created by auto mode or a late partner rather than by app.transition. */
  readonly auto: boolean
  /**
   * Settles with the swap, or rejects with its error. If this transition is still current it
   * also waits for the new page's reconcile. Supersede, abort and timeout don't settle it early.
   */
  readonly swapped: Promise<void>
  /** Never rejects. */
  readonly finished: Promise<TransitionResult>
  /** Filled when flying starts. */
  readonly flights: readonly Flight[]
  /** Unpaired copies of removed elements. Only with `leave` > 0 or in a browser view transition. */
  readonly leaving: readonly Presence[]
  /** New copies in view. Only with `enter` > 0 or in a browser view transition. */
  readonly entering: readonly Presence[]
  /** Lands everything now. Copies jump to their targets and fades end. */
  finish(): void
  /** Lands everything now and ends with `aborted`. */
  abort(): void
}

/** The current page: a scope closed when the next page replaces it. */
export interface PageScope {
  /** URL of the page. */
  readonly url: string
  /** Aborted when the page closes. */
  readonly signal: AbortSignal
  /** Runs when the next page replaces this one. Accepts app.attach handles as is. */
  onDispose(cleanup: Cleanup): Off
}

/** The `transition` service: call it with a swap to fly copies between pages. */
export interface TransitionApi {
  /** Snapshots, calls `swap` once synchronously and flies the pairs. A sync throw is rethrown. */
  (swap: Swap, options?: TransitionOptions): Transition
  /** The running transition, if any. */
  readonly current: ReadonlySignal<Transition | undefined>
  /** The current page. Closed right after the next swap. */
  readonly page: PageScope
}

/** Codes of `TransitionError`. */
export type TransitionErrorCode =
  | 'TRANSITION_SWAP'
  | 'TRANSITION_TIMEOUT'
  | 'TRANSITION_KEY'
  | 'TRANSITION_ANIMATE'

declare module '@dioramajs/core' {
  interface Services {
    /** Page transitions, see `TransitionApi`. */
    transition: TransitionApi
  }
  interface Events {
    /** The page at `url` is about to be replaced. */
    'page:leave': { readonly url: string }
    /** The page at `url` came in. */
    'page:enter': { readonly url: string }
    /** A transition ended. */
    'transition:end': { readonly transition: Transition; readonly result: TransitionResult }
  }
}
