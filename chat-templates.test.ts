import { test, expect } from 'bun:test'
import { planTemplateRefresh } from './chat-templates.ts'

const TPL = 'aaa', OLD = 'bbb', EDITED = 'ccc'

test('nothing to do: the live file is the template and we already knew', () => {
  expect(planTemplateRefresh({ tplH: TPL, liveH: TPL, baseline: TPL, unedited: true })).toEqual({ do: 'nothing' })
})

// THE INCIDENT: the canary instance copied the template 54ms before the main one looked, so the main
// instance saw a file it had never recorded as current — and said nothing, on the operator's own bot,
// about his chat agent's instructions changing. This is the case that used to be silent.
test('the file changed under us: record it AND announce it', () => {
  expect(planTemplateRefresh({ tplH: TPL, liveH: TPL, baseline: OLD, unedited: true }))
    .toEqual({ do: 'record', announce: true })
})

// The guard on that: a box we have never seen had its CLAUDE.md written by PROVISIONING moments ago.
// Announcing a refresh there would be a notice about something that never happened.
test('a first sighting is recorded in silence — provisioning is not a refresh', () => {
  expect(planTemplateRefresh({ tplH: TPL, liveH: TPL, unedited: true }))
    .toEqual({ do: 'record', announce: false })
  expect(planTemplateRefresh({ tplH: TPL, liveH: TPL, baseline: undefined, unedited: false }))
    .toEqual({ do: 'record', announce: false })
})

test('an unedited copy that is out of date gets overwritten', () => {
  expect(planTemplateRefresh({ tplH: TPL, liveH: OLD, baseline: OLD, unedited: true })).toEqual({ do: 'copy' })
})

// The one file the operator owns. It is never overwritten, whatever the baseline says.
test('an edited copy is left alone', () => {
  expect(planTemplateRefresh({ tplH: TPL, liveH: EDITED, baseline: OLD, unedited: false })).toEqual({ do: 'leave' })
  expect(planTemplateRefresh({ tplH: TPL, liveH: EDITED, unedited: false })).toEqual({ do: 'leave' })
})
