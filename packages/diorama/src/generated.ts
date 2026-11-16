// The slot for the site's effects folder. A build plugin (diorama/vite) points this module at
// a registry it generates. Without one it is empty and effects come from `start({ effects })`.
import type { EffectEntries } from '@diorama/effects'

export const effects: EffectEntries = {}
