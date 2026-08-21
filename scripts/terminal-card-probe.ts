// The three scheduler claims the live /terminal card rests on, run against a CHOSEN build.
//
//   bun scripts/terminal-card-probe.ts                 # this checkout — all three must pass
//   bun scripts/terminal-card-probe.ts <dir>           # another build's edit-scheduler.ts
//
// THE CONTROL IS THE POINT. Against a pre-v0.5.189 tree (`git archive main | tar -x -C /tmp/x`) all
// three must FAIL — that is what says they are claims about this change and not about arithmetic.
// The source-bound half lives in terminal-lifecycle.test.ts; this half needs a real scheduler tick,
// which a source read cannot give it.
const DIR = process.argv[2] || new URL('..', import.meta.url).pathname.replace(/\/$/, '')
const mod = await import(`${DIR}/edit-scheduler.ts`) as {
  startEditScheduler: (ch: unknown, token?: string) => void
  scheduleEdit: (o: Record<string, unknown>) => void
  scheduleDelete: (chat: string, mid: number, onOutcome?: (o: unknown) => void) => void
  flushPendingDeletes?: (ms?: number) => Promise<number>
}

const settle = (ms: number) => new Promise(r => setTimeout(r, ms))
const results: Array<[string, boolean, string]> = []
const check = (name: string, ok: boolean, detail = '') => results.push([name, ok, detail])

let edits = 0, deleteCalls = 0, deleted = 0
let failNextDeletes = 0
const channel = {
  async editText() { edits += 1 },
  async deleteMessage() {
    deleteCalls += 1
    if (failNextDeletes > 0) { failNextDeletes -= 1; throw new Error('Bad Gateway') }
    deleted += 1
  },
}
mod.startEditScheduler(channel)

// 1 · SEED. A card whose content has not changed must not re-send the text it was created with.
// Without the seed the first tick sends an identical edit, Telegram answers 400 "message is not
// modified", and because `lastText` is only set after a SUCCESSFUL edit every later tick repeats it.
const HTML = '📺 <b>Live terminal · 1 lines</b>'
mod.scheduleEdit({ chat: '1', mid: 1, source: 'terminal', seed: HTML, render: () => HTML })
await settle(500)
check('seed suppresses the no-op first edit', edits === 0, `${edits} edit(s) sent`)

// 2 · RETRY. A transient delete failure must be retried, not dropped — the row used to be removed
// before the await and the call ended in `.catch(() => {})`, so one failure orphaned the card forever.
failNextDeletes = 2
const outcomes: unknown[] = []
mod.scheduleDelete('1', 2, o => outcomes.push(o))
await settle(1500)
check('a failed delete is retried until the message is gone', deleted >= 1 && deleteCalls >= 3,
      `${deleteCalls} attempt(s), ${deleted} delete(s)`)
check('the delete reports its outcome to the caller', outcomes.length > 0, `${outcomes.length} outcome(s)`)

// 3 · DRAIN. The shutdown path must be able to spend its last seconds on queued deletes.
const before = deleted
mod.scheduleDelete('1', 3)
const flushed = typeof mod.flushPendingDeletes === 'function' ? await mod.flushPendingDeletes(1_000) : -1
check('the shutdown drain can flush queued deletes', flushed >= 1 && deleted > before,
      flushed < 0 ? 'flushPendingDeletes is not exported by this build' : `flushed ${flushed}`)

console.log(`build: ${DIR}\n`)
for (const [name, ok, detail] of results) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
const failed = results.filter(r => !r[1]).length
console.log(`\n${results.length - failed}/${results.length} passed`)
process.exit(failed ? 1 : 0)
