import { test, expect } from 'bun:test'
import { shouldStamp } from './stamp-transcript.ts'

const passthrough = (p: string) => p

test('cwd matches paneCwd → stamp allowed', () => {
  expect(shouldStamp({
    path: '/home/ubuntu/.claude/projects/-home-ubuntu-projects-cc-bridge/new.jsonl',
    cwd: '/home/ubuntu/projects/cc-bridge',
    paneCwd: '/home/ubuntu/projects/cc-bridge',
    currentStamp: null,
    norm: passthrough,
  })).toBe(true)
})

test('cwd mismatch, currentStamp in same project dir as new path → allowed (rename+/clear case)', () => {
  expect(shouldStamp({
    path: '/home/ubuntu/.claude/projects/-home-ubuntu-projects-claude-tg/new.jsonl',
    cwd: '/home/ubuntu/projects/claude-tg',
    paneCwd: '/home/ubuntu/projects/cc-bridge',
    currentStamp: '/home/ubuntu/.claude/projects/-home-ubuntu-projects-claude-tg/old.jsonl',
    norm: passthrough,
  })).toBe(true)
})

test('cwd mismatch, currentStamp under a different project dir → refused', () => {
  expect(shouldStamp({
    path: '/home/ubuntu/.claude/projects/-home-ubuntu-projects-claude-tg/new.jsonl',
    cwd: '/home/ubuntu/projects/claude-tg',
    paneCwd: '/home/ubuntu/projects/cc-bridge',
    currentStamp: '/home/ubuntu/.claude/projects/-tmp-foo/x.jsonl',
    norm: passthrough,
  })).toBe(false)
})

test('cwd mismatch, no currentStamp → refused', () => {
  expect(shouldStamp({
    path: '/home/ubuntu/.claude/projects/-home-ubuntu-projects-claude-tg/new.jsonl',
    cwd: '/home/ubuntu/projects/claude-tg',
    paneCwd: '/home/ubuntu/projects/cc-bridge',
    currentStamp: null,
    norm: passthrough,
  })).toBe(false)
})

test('empty cwd → allowed', () => {
  expect(shouldStamp({
    path: '/home/ubuntu/.claude/projects/-home-ubuntu-projects-cc-bridge/new.jsonl',
    cwd: '',
    paneCwd: '/home/ubuntu/projects/cc-bridge',
    currentStamp: null,
    norm: passthrough,
  })).toBe(true)
})

test('paneCwd null/unreadable → allowed', () => {
  expect(shouldStamp({
    path: '/home/ubuntu/.claude/projects/-home-ubuntu-projects-cc-bridge/new.jsonl',
    cwd: '/home/ubuntu/projects/cc-bridge',
    paneCwd: null,
    currentStamp: null,
    norm: passthrough,
  })).toBe(true)
})
