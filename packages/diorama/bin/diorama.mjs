#!/usr/bin/env node
import { run } from '../dist/cli.js'

const result = run(process.argv.slice(2))
// A watcher keeps the process alive. --check never watches.
if (!process.argv.includes('--watch') || process.argv.includes('--check'))
  process.exitCode = result.code
