// The backtick footgun: a session writing `code spans` into a double-quoted shell body has the
// shell RUN them and splice stdout into the message. tgctl can't undo that, but it must catch the
// common case — a backticked `tg …` command, whose output is our own usage/result text.
import { expect, test, describe } from 'bun:test'
import { looksSpliced } from './spliced.ts'



describe('spliced-output fingerprint', () => {
  test('catches the message that actually shipped corrupted', () => {
    // Verbatim from the bus ledger, 2026-07-25 18:55:32.
    expect(looksSpliced('cc-bridge appended [1m] to every spawn alias, so error: usage: tg spawn <name> [--dir p [--create]] [--model fable|opus|sonnet|haiku] [--effort low…max] ["first message"] was dead on arrival.')).toBe(true)
  })

  test('catches spliced success output too', () => {
    for (const s of [
      'I ran ok: spawned "x" in /tmp and it worked',
      'the reply was ok: answered @chat (ask 109)',
      'usage: tg kill <name>   end a session',
    ]) expect(looksSpliced(s)).toBe(true)
  })

  test('leaves ordinary prose about these commands alone', () => {
    // Escaped backticks / stdin bodies keep the literal text — those must still send.
    for (const s of [
      'run `tg spawn foo` to start one, then `tg kill foo`',
      'the usage line for tgctl is printed by --help',
      'I spawned it and answered the ask',
      'ok: spawnedX is not a real prefix',
    ]) expect(looksSpliced(s)).toBe(false)
  })
})
