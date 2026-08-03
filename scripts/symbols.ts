#!/usr/bin/env bun
// Symbol index for this repo's oversized files: name -> line, so a session turns a symbol into a line
// number without paying a locate-grep. Measured on one 2026-08-02 session: 50 greps that found nothing
// but line numbers cost 28,655 tokens before a single line of content was read.
//
//   bun scripts/symbols.ts                  # every tracked .ts over 5,000 lines (today: daemon.ts)
//   bun scripts/symbols.ts transcript.ts    # or name files explicitly
//   bun scripts/symbols.ts | grep -i relay  # the cheap daily form — a few rows, not the whole index
//
// On demand, never checked in: an index committed beside the file is stale the instant the file
// changes, and lands in every diff of a checkout three sessions share.
//
// Column-0 declarations only. That is the whole definition layer of daemon.ts, which nests nothing at
// module scope — but it does mean this finds definitions, not call sites, and only in TypeScript.
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const BIG = 5000
const DECL = /^(?:export\s+)?(?:async\s+)?(?:function|const|let|type|interface|class|enum)\s+([A-Za-z_$][\w$]*)/

// Trailing newline would otherwise report one line more than `wc -l` does.
const readLines = (f: string) => readFileSync(f, 'utf8').replace(/\n$/, '').split('\n')
const countLines = (f: string) => readLines(f).length

const named = process.argv.slice(2)
const files = named.length
  ? named
  : execFileSync('git', ['ls-files', '*.ts'], { encoding: 'utf8' })
      .split('\n')
      .filter(Boolean)
      .filter(f => countLines(f) > BIG)

for (const file of files) {
  const lines = readLines(file)
  const hits = lines.flatMap((text, i) => {
    const m = DECL.exec(text)
    return m ? [`${String(i + 1).padStart(5)}  ${m[1]}`] : []
  })
  console.log(`\n${file} — ${lines.length} lines, ${hits.length} symbols`)
  console.log(hits.join('\n'))
}
