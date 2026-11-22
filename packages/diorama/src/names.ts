// Public package names, kept in one place.

/** The package a site installs and imports. */
export const SITE = '@dioramajs/diorama'
/** Its command line, `npx dioramajs gen` and `npx dioramajs add`. */
export const BIN = 'dioramajs'
/** The scope of the packages it is built from. */
export const SCOPE = '@dioramajs'
/** The export condition that points a package's entries at its sources. */
export const SOURCE: string = `${SCOPE}/source`
