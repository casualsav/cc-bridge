import { test, expect } from 'bun:test'
import { bridgeVersion, claudeBin } from './updates.ts'

test('bridgeVersion reads a semver or degrades to "?"', () => {
  expect(bridgeVersion()).toMatch(/^(\d+\.\d+\.\d+|\?)$/)
})

test('claudeBin resolves to an absolute path or the bare name', () => {
  const b = claudeBin()
  expect(b === 'claude' || b.startsWith('/')).toBe(true)
})
