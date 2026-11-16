#!/usr/bin/env node
import { run } from '../dist/cli.js'

const result = run(process.argv.slice(2))
if (!process.argv.includes('--watch')) process.exitCode = result.code
