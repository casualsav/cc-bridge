import { test, expect } from 'bun:test'
import { detectAccountTier } from './prompt.ts'

// Captured live 2026-07-26 (v2.1.220's redesigned banner).
const NEW_STYLE_BANNER = [
  ' ▐▛███▜▌   Claude Code v2.1.220',
  '▝▜█████▛▘  Opus 5 (1M context) with high effort · Claude Max',
  '  ▘▘ ▝▝    ~/projects',
].join('\n')

// Captured live 2026-07-26 (npm 2.1.205's boxed banner) — one line inside the box.
const OLD_BOXED_BANNER_LINE = '│    Haiku 4.5 · Claude Pro · suchag@gmail.com\'s     │'

test('detectAccountTier reads the new-style banner', () => {
  expect(detectAccountTier(NEW_STYLE_BANNER)).toBe('max')
})

test('detectAccountTier reads the old boxed banner', () => {
  expect(detectAccountTier(OLD_BOXED_BANNER_LINE)).toBe('pro')
})

test('detectAccountTier is null on an ordinary prompt capture with no banner', () => {
  const cap = ['user@host:~/projects (main)', '', '❯ ', '? for shortcuts'].join('\n')
  expect(detectAccountTier(cap)).toBe(null)
})

test('detectAccountTier ignores "Claude Pro" in conversation text — a bare tier match with no model-name anchor', () => {
  // This project's own sessions routinely discuss the stale-tier-cache bug by name, so a bare
  // `Claude (Max|Pro)` match would false-positive on ordinary chat/code output constantly.
  const cap = [
    'the stale "Claude Pro" cache that gated Fable',
    'alert on · Claude Pro drift',
  ].join('\n')
  expect(detectAccountTier(cap)).toBe(null)
})
