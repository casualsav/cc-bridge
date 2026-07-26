// The rule these pin: there is one supported spelling, target-first (`@worker /exit`), and the other
// one must be REFUSED rather than merely unbuilt. Those are opposite outcomes. On the HEAD this
// replaced, `/exit @worker` was not refused and did not reach @worker — it fell through to the local
// relay, which read it as a plain `/exit` and ended the session the caller was typing in. So every
// case below is really one question: can a mistyped target ever degrade into a bare local command?
import { test, expect } from 'bun:test'
import { looksLikeArgForm, exitCommandArg } from './named-command.ts'

// ---- the argument spelling, which must be caught before the local handler ----

test('an @name argument is recognised as the wrong spelling', () => {
  expect(looksLikeArgForm('@worker')).toBe(true)
  expect(looksLikeArgForm('  @worker  ')).toBe(true)
})

// Broader than an exact `@name` on purpose: this is the same mistake, and refusing costs nothing
// while acting on it locally clears/restarts the wrong session.
test('an @name followed by anything else is still the wrong spelling', () => {
  expect(looksLikeArgForm('@worker now')).toBe(true)
  expect(looksLikeArgForm('@a @b')).toBe(true)
})

test('no argument is the local command, untouched', () => {
  expect(looksLikeArgForm('')).toBe(false)
  expect(looksLikeArgForm('   ')).toBe(false)
})

// `/restart all` predates this and must keep working.
test('an ordinary argument is not a targeting attempt', () => {
  expect(looksLikeArgForm('all')).toBe(false)
  expect(looksLikeArgForm('default medium')).toBe(false)
})

// ---- /exit, where the failure is worst ----

test('bare /exit keeps its meaning: end the session you are in', () => {
  expect(exitCommandArg('/exit')).toBeNull()
  expect(exitCommandArg('/quit')).toBeNull()
  expect(exitCommandArg('  /exit  ')).toBeNull()
})

test('/exit with a target is the wrong spelling and must be caught', () => {
  expect(exitCommandArg('/exit @cc-pin')).toBe('cc-pin')
  expect(exitCommandArg('/quit @cc-pin')).toBe('cc-pin')
})

// Without the @ it used to reach the local relay and end the CALLER's session. It must still be
// caught — `/exit worker` is the same mistake, not a bare exit with a stray word.
test('/exit name without the @ is caught too, never treated as a local exit', () => {
  expect(exitCommandArg('/exit cc-pin')).toBe('cc-pin')
})

// ---- the safety property, stated directly ----
//
// A malformed target must never parse as "no argument", because "no argument" is the one reading
// that ends the caller's own session. Every one of these has to come back non-null so the daemon
// refuses it and names the right spelling.
test('a malformed target never degrades into a bare /exit', () => {
  for (const bad of ['/exit @', '/exit @@', '/exit @nosuchsession', '/exit @-', '/exit @123', '/quit @']) {
    expect(exitCommandArg(bad)).not.toBeNull()
  }
})

test('only a genuinely argument-less /exit reads as the local one', () => {
  for (const bare of ['/exit', '/quit', '/exit@ccbridgebot']) {
    expect(exitCommandArg(bare, 'ccbridgebot')).toBeNull()
  }
})

// ---- Telegram's own @bot suffix ----

test('our own @bot suffix is stripped, not read as a target', () => {
  expect(exitCommandArg('/exit@ccbridgebot @cc-pin', 'ccbridgebot')).toBe('cc-pin')
  expect(exitCommandArg('/exit@CCBridgeBot @cc-pin', 'ccbridgebot')).toBe('cc-pin')
})

test('a command addressed to a DIFFERENT bot is not ours to act on', () => {
  expect(exitCommandArg('/exit@otherbot @cc-pin', 'ccbridgebot')).toBeNull()
})

test('a command that merely starts with exit is not /exit', () => {
  expect(exitCommandArg('/exiting @cc-pin')).toBeNull()
})
