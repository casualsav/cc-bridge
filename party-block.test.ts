import { test, expect } from 'bun:test'
import { formatAskBlock, formatAnswerBlock } from './party-block.ts'

test('formatAskBlock carries @from, the ask id, and the text', () => {
  expect(formatAskBlock('architect', 7, 'scrape pricing pages'))
    .toBe('<tg @architect ask=7>scrape pricing pages</tg>')
})

test('formatAskBlock appends refs as one quoted, space-joined attribute', () => {
  expect(formatAskBlock('architect', 7, 'go', ['party/-100/shared/a.md', 'party/-100/shared/b.json']))
    .toBe('<tg @architect ask=7 refs="party/-100/shared/a.md party/-100/shared/b.json">go</tg>')
})

test('formatAnswerBlock echoes the ask id via re=', () => {
  expect(formatAnswerBlock('executor', 7, 'done — 900 rows', ['party/-100/shared/x.json']))
    .toBe('<tg @executor re=7 refs="party/-100/shared/x.json">done — 900 rows</tg>')
})

test('empty / whitespace refs are dropped, no refs attribute emitted', () => {
  expect(formatAskBlock('a', 1, 'hi', ['', '  '])).toBe('<tg @a ask=1>hi</tg>')
  expect(formatAskBlock('a', 1, 'hi', [])).toBe('<tg @a ask=1>hi</tg>')
})

test('a double-quote in a ref is HTML-escaped so the attribute never breaks', () => {
  expect(formatAskBlock('a', 1, 'hi', ['party/-100/shared/we"ird.md']))
    .toBe('<tg @a ask=1 refs="party/-100/shared/we&quot;ird.md">hi</tg>')
})
