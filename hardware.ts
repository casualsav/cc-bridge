// Shared hardware probe + local-Whisper model recommendation. Used by the setup wizard
// (sizing the transcription model to the machine at install) and the daemon (the in-chat
// voice picker's recommendation). Keeping it in one place means the wizard and the live
// /settings picker can never drift on what they suggest.
import { execFileSync } from 'node:child_process'
import { totalmem, freemem, cpus } from 'node:os'

// The local Whisper model ladder, smallest/fastest → largest/most accurate. `large-v3-turbo`
// is a distilled large-v3 (near-large accuracy, much faster). Order matters: callers index it.
export const WHISPER_MODELS = ['tiny', 'base', 'small', 'medium', 'large-v3', 'large-v3-turbo'] as const
export type WhisperModel = (typeof WHISPER_MODELS)[number]

// Rough peak RAM + on-disk weight size per model, for the picker's "will it fit" guidance and
// the download-size heads-up. Approximate (int8); good enough to steer a choice.
export const WHISPER_INFO: Record<WhisperModel, { peakRamGB: number; weightsMB: number }> = {
  tiny: { peakRamGB: 0.5, weightsMB: 75 },
  base: { peakRamGB: 0.7, weightsMB: 145 },
  small: { peakRamGB: 1.2, weightsMB: 250 },
  medium: { peakRamGB: 2.2, weightsMB: 1500 },
  'large-v3': { peakRamGB: 4.0, weightsMB: 3000 },
  'large-v3-turbo': { peakRamGB: 4.0, weightsMB: 1600 },
}

export type HardwareProbe = {
  gpu: boolean
  vramGB: number | null
  cores: number
  totalRamGB: number
  freeRamGB: number
}

let _probe: HardwareProbe | null = null

// Detect GPU (+ VRAM), CPU cores, and RAM. Cached for the process. Pure read-only —
// no installs, no network. RAM comes from node:os so it's portable (Linux + macOS) with
// no shelling out; GPU/VRAM need nvidia-smi (absent ⇒ treated as no CUDA GPU).
export function probeHardware(): HardwareProbe {
  if (_probe) return _probe
  let gpu = false
  let vramGB: number | null = null
  try {
    execFileSync('nvidia-smi', ['-L'], { timeout: 3000, stdio: 'ignore' })
    gpu = true
    try {
      const out = execFileSync('nvidia-smi', ['--query-gpu=memory.total', '--format=csv,noheader,nounits'], { timeout: 3000 }).toString()
      const mib = parseInt(out.split('\n')[0]?.trim() || '', 10)
      if (mib > 0) vramGB = Math.round((mib / 1024) * 10) / 10
    } catch {}
  } catch {}
  // `nproc` is the truest "available cores" on Linux (respects cgroup limits); fall back to os.cpus().
  let cores = 0
  try { cores = parseInt(execFileSync('nproc', [], { timeout: 2000 }).toString().trim(), 10) } catch {}
  if (!cores) cores = cpus().length || 4
  const totalRamGB = Math.round((totalmem() / 1e9) * 10) / 10
  const freeRamGB = Math.round((freemem() / 1e9) * 10) / 10
  _probe = { gpu, vramGB, cores, totalRamGB, freeRamGB }
  return _probe
}

export type WhisperRecommendation = {
  model: WhisperModel
  device: 'cpu' | 'cuda'
  compute: 'int8'
  reason: string
}

// Size a local Whisper model to the machine. GPU ⇒ turbo on cuda; otherwise scale by cores,
// then clamp down if RAM is tight (a model that swaps is worse than a smaller one that fits).
// Returns the pick plus a one-line human rationale the wizard/picker can show.
export function recommendWhisper(probe: HardwareProbe = probeHardware()): WhisperRecommendation {
  if (probe.gpu) {
    const v = probe.vramGB ? ` (${probe.vramGB} GB VRAM)` : ''
    return { model: 'large-v3-turbo', device: 'cuda', compute: 'int8', reason: `CUDA GPU detected${v} — near-large accuracy, still fast.` }
  }
  let model: WhisperModel = probe.cores >= 4 ? 'small' : 'base'
  let reason = probe.cores >= 4
    ? `${probe.cores} CPU cores — \`small\` balances accuracy and latency for chat (\`medium\` is ~3× slower).`
    : `${probe.cores} CPU cores — \`base\` keeps notes snappy on a small box.`
  // RAM clamp: medium peaks ~2 GB, large ~4 GB. With <3 GB total, even `small` is the ceiling.
  if (probe.totalRamGB > 0 && probe.totalRamGB < 3 && model !== 'base' && model !== 'tiny') {
    model = 'base'
    reason = `Only ${probe.totalRamGB} GB RAM — \`base\` to stay well clear of swapping.`
  }
  return { model, device: 'cpu', compute: 'int8', reason }
}

// One-line summary of the probe for display, e.g. "8 cores · 16 GB RAM · no CUDA GPU".
export function describeHardware(probe: HardwareProbe = probeHardware()): string {
  const gpu = probe.gpu ? `CUDA GPU${probe.vramGB ? ` ${probe.vramGB} GB` : ''}` : 'no CUDA GPU'
  return `${probe.cores} cores · ${probe.totalRamGB} GB RAM · ${gpu}`
}
