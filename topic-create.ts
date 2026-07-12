import { join } from 'node:path'
import { STATE_DIR, readJsonFile, writeJsonFile } from './common.ts'
import type { AgentKind } from './agent.ts'

export type TopicCreateOffer = {
  name: string
  dir: string
  repo?: string
  agent: AgentKind
}

export const TOPIC_CREATE_FILE = join(STATE_DIR, 'topic-create-pending.json')
let offers = new Map<number, TopicCreateOffer>()
let loaded = false
let persist = true

function load(): void {
  if (loaded) return
  loaded = true
  const raw = readJsonFile<Record<string, Partial<TopicCreateOffer>>>(TOPIC_CREATE_FILE, {})
  for (const [key, value] of Object.entries(raw)) {
    const thread = Number(key)
    if (!Number.isInteger(thread) || !value || typeof value.name !== 'string' || typeof value.dir !== 'string') continue
    offers.set(thread, {
      name: value.name,
      dir: value.dir,
      ...(typeof value.repo === 'string' ? { repo: value.repo } : {}),
      agent: value.agent === 'codex' ? 'codex' : 'claude',
    })
  }
}

function save(): void {
  if (persist) writeJsonFile(TOPIC_CREATE_FILE, Object.fromEntries(offers))
}

export function getTopicCreate(thread: number): TopicCreateOffer | undefined {
  load()
  return offers.get(thread)
}

export function setTopicCreate(thread: number, offer: Omit<TopicCreateOffer, 'agent'> & { agent?: AgentKind }): TopicCreateOffer {
  load()
  const next: TopicCreateOffer = { ...offer, agent: offer.agent ?? offers.get(thread)?.agent ?? 'claude' }
  offers.set(thread, next)
  save()
  return next
}

export function setTopicCreateAgent(thread: number, agent: AgentKind): boolean {
  load()
  const offer = offers.get(thread)
  if (!offer) return false
  offers.set(thread, { ...offer, agent })
  save()
  return true
}

export function removeTopicCreate(thread: number): void {
  load()
  if (offers.delete(thread)) save()
}

export function topicCreateAgentLabel(agent: AgentKind): string {
  return agent === 'codex' ? 'Codex' : 'Claude Code'
}

export function _resetTopicCreateForTest(seed: Record<string, TopicCreateOffer> = {}): void {
  offers = new Map(Object.entries(seed).map(([thread, offer]) => [Number(thread), offer]))
  loaded = true
  persist = false
}
