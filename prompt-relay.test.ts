import { test, expect } from 'bun:test'
import { renderPromptHtml, permButtonLabel, singleAnswerKeyboard, permStorms, renderStuckHtml, stuckKeyboard } from './prompt-relay.ts'

test('renderPromptHtml: question bold, options numbered, descriptions italic (not quoted)', () => {
  const html = renderPromptHtml({
    question: 'Pick one', options: [{ label: 'A' }, { label: 'B', description: 'second' }],
    multiSelect: false, tabbed: false, freeText: false, chat: false,
  } as never)
  expect(html).toContain('<b>Pick one</b>')
  expect(html).toContain('1.')
  expect(html).toContain('<i>second</i>')
  expect(html).not.toContain('<blockquote>')
})

test('permButtonLabel: icons by intent, hints stripped, capped', () => {
  expect(permButtonLabel({ n: 1, label: 'Yes' })).toBe('✅ Yes')
  expect(permButtonLabel({ n: 2, label: 'Yes, allow all edits during this session (shift+tab)' })).toMatch(/^🔁 Yes, allow all/)
  expect(permButtonLabel({ n: 3, label: 'No, and tell Claude what to do differently' })).toMatch(/^❌ No/)
  expect(permButtonLabel({ n: 1, label: 'x'.repeat(60) }).length).toBeLessThanOrEqual(42)
})

test('singleAnswerKeyboard routes answers through the given prefix', () => {
  const kb = singleAnswerKeyboard({
    question: 'Q', options: [{ label: 'One' }, { label: 'Two' }],
    multiSelect: false, tabbed: true, freeText: false, chat: false,
  } as never, 'mq')
  const datas = kb.inline_keyboard.flat().map(b => 'callback_data' in b ? b.callback_data : '')
  expect(datas).toContain('mq:1')
  expect(datas).toContain('mq:2')
})

test('permStorms map is shared state the daemon can arm', () => {
  permStorms.set('%99', { count: 2, armed: false })
  expect(permStorms.get('%99')!.armed).toBe(false)
  permStorms.delete('%99')
})

test('renderStuckHtml: name heading, <pre> tail, numbered options, raw-key wording', () => {
  const html = renderStuckHtml('proj', 'Exit plan mode?\n1. Yes\n2. No', [{ label: 'Yes' }, { label: 'No' }])
  expect(html).toContain('<b>proj</b>')
  expect(html).toContain('<pre>Exit plan mode?')
  expect(html).toContain('<b>1.</b> Yes')
  expect(html).toContain('<b>2.</b> No')
  expect(html).toMatch(/raw key/i)   // wording must say raw keys are sent
})

test('stuckKeyboard: one row per parsed option, fixed fallback keys + full-screen dump', () => {
  const kb = stuckKeyboard('abcd1234', { optionKind: 'numbered', count: 2 })
  const datas = kb.inline_keyboard.flat().map(b => 'callback_data' in b ? b.callback_data : '')
  expect(datas).toContain('stuck:abcd1234:o0')
  expect(datas).toContain('stuck:abcd1234:o1')
  expect(datas).toContain('stuck:abcd1234:k:Enter')
  expect(datas).toContain('stuck:abcd1234:k:Escape')
  expect(datas).toContain('stuck:abcd1234:k:Up')
  expect(datas).toContain('stuck:abcd1234:k:Down')
  expect(datas).toContain('stuck:abcd1234:full')
})

test('every stuck callback_data stays under Telegram’s 64-byte cap', () => {
  const kb = stuckKeyboard('deadbeef', { optionKind: 'ink', count: 8 })
  for (const b of kb.inline_keyboard.flat())
    if ('callback_data' in b) expect(Buffer.byteLength(b.callback_data!, 'utf8')).toBeLessThanOrEqual(64)
})
