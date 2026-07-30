// Fix 2 — writeJsonFile must land by tmp+rename, never by truncating the live file.
//
// The gate is the WRITE SEQUENCE, asserted through two consequences that rename(2) has and a
// truncating write cannot fake — no fs mocking, no timing:
//   · rename replaces the directory entry, so the target gets a NEW inode each write. A
//     writeFileSync onto the same path keeps the inode.
//   · a reader holding an fd opened before the write still sees the OLD, COMPLETE document,
//     because its fd points at the replaced inode. Under a truncating write that same fd observes
//     the file being rewritten underneath it — which is how a reader gets half a JSON document.
// The "concurrent reader never sees partial content" property is what actually matters; asserting it
// with racing threads would be timing-dependent, so it is pinned deterministically by the fd test
// below instead.
import { test, expect } from 'bun:test'
import { mkdtempSync, statSync, readdirSync, openSync, readFileSync, readSync, closeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeJsonFile } from './common.ts'

function tmpFile(): string {
  return join(mkdtempSync(join(tmpdir(), 'atomic-write-')), 'store.json')
}

test('each write replaces the file (new inode) rather than truncating it in place', () => {
  const path = tmpFile()
  writeJsonFile(path, { v: 1 })
  const first = statSync(path).ino
  writeJsonFile(path, { v: 2 })
  const second = statSync(path).ino

  expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ v: 2 })
  expect(second).not.toBe(first)   // unfixed: same inode — the live file was truncated and rewritten
})

test('a reader holding an open fd never observes a partially written document', () => {
  const path = tmpFile()
  const big = { rows: Array.from({ length: 2000 }, (_, i) => ({ i, pad: 'x'.repeat(40) })) }
  writeJsonFile(path, big)

  const fd = openSync(path, 'r')   // reader opens BEFORE the next write
  try {
    writeJsonFile(path, { rows: [] })
    const size = statSync(path).size
    const buf = Buffer.alloc(1024 * 1024)
    const n = readSync(fd, buf, 0, buf.length, 0)
    const seen = buf.subarray(0, n).toString('utf8')
    // The old fd must still yield the complete previous document, parseable in full.
    expect(() => JSON.parse(seen)).not.toThrow()
    expect(JSON.parse(seen).rows.length).toBe(2000)
    expect(size).toBeLessThan(n)   // the new file really is the small one; we read the old inode
  } finally { closeSync(fd) }
})

test('no .tmp scratch file is left behind', () => {
  const path = tmpFile()
  writeJsonFile(path, { a: 1 })
  const strays = readdirSync(join(path, '..')).filter(f => f.endsWith('.tmp'))
  expect(strays).toEqual([])
})

test('an unwritable target does not throw and does not leave a tmp behind', () => {
  // Same swallow-errors contract as before the change: state writes are best-effort.
  const dir = mkdtempSync(join(tmpdir(), 'atomic-write-'))
  const path = join(dir, 'no-such-subdir', 'store.json')
  expect(() => writeJsonFile(path, { a: 1 })).not.toThrow()
  expect(readdirSync(dir).filter(f => f.endsWith('.tmp'))).toEqual([])
})
