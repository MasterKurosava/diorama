// The slot for the site's effects folder. A build plugin (diorama/vite) points this module at
// a registry it generates. Without one it is empty and effects come from `start({ effects })`.
import type { EffectEntries } from '@dioramajs/effects'

/** The site's effects, filled in by a build plugin. */
export const effects: EffectEntries = {}
