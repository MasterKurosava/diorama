import { docsUrl } from '@dioramajs/core/dev'
import type { GlslCode, GlslDiagnostic } from '../types'

const ERRORS: ReadonlySet<GlslCode> = new Set<GlslCode>([
  'GLSL_SYNTAX',
  'GLSL_NO_ENTRY',
  'GLSL_INCLUDE',
  'GLSL_GLSLIFY',
  'GLSL_OUTPUT',
  'GLSL_INOUT',
  'GLSL_EARLY_RETURN',
  'GLSL_ARRAY',
  'GLSL_GLOBAL_STATE',
  'GLSL_SAMPLER',
  'GLSL_UNIFORM_TYPE',
  'GLSL_UNSUPPORTED_TYPE',
  'GLSL_NAME_CLASH',
  'GLSL_STAGE',
  'GLSL_VERTEX',
  'GLSL_UNKNOWN_IDENTIFIER',
  'GLSL_UNKNOWN_FUNCTION',
  'GLSL_TRANSPILER',
  'GLSL_TEXTURE',
  'GLSL_PRAGMA',
])
const INFOS: ReadonlySet<GlslCode> = new Set<GlslCode>([
  'GLSL_TOVAR',
  'GLSL_SINGLE_EXIT',
  'GLSL_RENAMED',
  'GLSL_COVER',
  'GLSL_FRAGCOORD',
  'GLSL_ANIMATE',
])

export const NO_ARRAYS = 'arrays are not supported'
export const NO_ARRAYS_HINT = 'replace the array with separate variables or a function'
export const PORT_BY_HAND =
  'declare the function as a prototype and port it by hand (see the GLSL-to-TSL guide)'

export const severityOf = (code: GlslCode): GlslDiagnostic['severity'] =>
  ERRORS.has(code) ? 'error' : INFOS.has(code) ? 'info' : 'warning'

/** Thrown when a conversion fails. Carries every error, not just the first. */
export class GlslError extends Error {
  /** Always `GlslError`. */
  override readonly name: 'GlslError' = 'GlslError'
  /** In source order. */
  readonly diagnostics: readonly GlslDiagnostic[]

  constructor(diagnostics: readonly GlslDiagnostic[]) {
    const first = diagnostics[0]
    const more = diagnostics.length > 1 ? ` (+${diagnostics.length - 1} more)` : ''
    super(first ? `${format(first)}${more}` : 'GLSL conversion failed')
    this.diagnostics = diagnostics
  }
}

/** `wave.frag:12:5 error GLSL_INOUT message`, then the hint, the page of the code and the frame. */
export function format(diagnostic: GlslDiagnostic, withFrame = false): string {
  let text = `${diagnostic.file}:${diagnostic.line}:${diagnostic.column} ${diagnostic.severity} ${diagnostic.code} ${diagnostic.message}`
  if (diagnostic.hint) text += `\n  → ${diagnostic.hint}`
  text += `\n  ${docsUrl(diagnostic.code)}`
  if (withFrame && diagnostic.frame) text += `\n${diagnostic.frame}`
  return text
}

/** Three source lines around `line` with a caret under `column`. */
export function codeFrame(lines: readonly string[], line: number, column: number): string {
  const out: string[] = []
  const width = String(Math.min(lines.length, line + 1)).length
  for (let number = Math.max(1, line - 1); number <= Math.min(lines.length, line + 1); number++) {
    const text = (lines[number - 1] ?? '').replace(/\t/g, '  ')
    out.push(`${number === line ? '>' : ' '} ${String(number).padStart(width)} | ${text}`)
    if (number === line)
      out.push(`  ${' '.repeat(width)} | ${' '.repeat(Math.max(0, column - 1))}^`)
  }
  return out.join('\n')
}

export interface Position {
  readonly file: string
  readonly line: number
  readonly column: number
}

/** Collects diagnostics with frames from the original files. */
export class Reporter {
  readonly list: GlslDiagnostic[] = []
  /** Original lines of every file read, for frames. */
  readonly files: Map<string, readonly string[]> = new Map()
  /** Same code, place and message is reported once. */
  private readonly seen = new Set<string>()

  add(code: GlslCode, at: Position, message: string, hint?: string): void {
    const key = `${code}\0${at.file}\0${at.line}\0${at.column}\0${message}`
    if (this.seen.has(key)) return
    this.seen.add(key)
    const lines = this.files.get(at.file) ?? []
    this.list.push({
      code,
      severity: severityOf(code),
      message,
      hint,
      file: at.file,
      line: at.line,
      column: at.column,
      frame: codeFrame(lines, at.line, at.column),
    })
  }

  get errors(): GlslDiagnostic[] {
    return this.list.filter((diagnostic) => diagnostic.severity === 'error')
  }

  throwIfErrors(): void {
    if (this.errors.length) throw this.failure()
  }

  /** For a run that has to stop. Stopping with no error reported is a converter bug. */
  failure(): GlslError {
    const errors = this.errors
    if (!errors.length) throw new Error('@dioramajs/glsl: conversion stopped without an error')
    return new GlslError(sorted(errors))
  }
}

export const sorted = (list: readonly GlslDiagnostic[]): GlslDiagnostic[] =>
  [...list].sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column)
