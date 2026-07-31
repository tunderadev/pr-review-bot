import { appendFileSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

export const DEFAULT_TELEMETRY_PATH = join(homedir(), '.config', 'pr-review-bot', 'telemetry.jsonl')

// Deleted outright, not rotated: a .bak would defeat the point of keeping
// measurement windows from accumulating files on disk.
export function resetTelemetry(path = DEFAULT_TELEMETRY_PATH) {
  if (!existsSync(path)) return false
  rmSync(path)
  return true
}

export function createTelemetry({ enabled, path = DEFAULT_TELEMETRY_PATH }) {
  return {
    enabled: Boolean(enabled),
    // Returns whether anything was written, so callers can assert the off-path.
    record(entry) {
      if (!enabled) return false
      mkdirSync(dirname(path), { recursive: true })
      appendFileSync(path, `${JSON.stringify(entry)}\n`)
      return true
    },
  }
}

export function summarize(jsonlText) {
  const rows = jsonlText
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => { try { return JSON.parse(l) } catch { return null } })
    .filter(Boolean)

  const perReview = new Map()
  const byPhase = {}
  const byModel = {}
  for (const r of rows) {
    const key = `${r.repo}#${r.number}@${r.round ?? 1}`
    perReview.set(key, (perReview.get(key) || 0) + (r.costUsd || 0))
    byPhase[r.phase] ??= { calls: 0, costUsd: 0 }
    byPhase[r.phase].calls += 1
    byPhase[r.phase].costUsd += r.costUsd || 0
    if (r.model) {
      byModel[r.model] ??= { calls: 0, costUsd: 0, inputTokens: 0, outputTokens: 0 }
      byModel[r.model].calls += 1
      byModel[r.model].costUsd += r.costUsd || 0
      byModel[r.model].inputTokens += r.inputTokens || 0
      byModel[r.model].outputTokens += r.outputTokens || 0
    }
  }
  const costs = [...perReview.values()]
  const total = costs.reduce((a, b) => a + b, 0)
  return {
    reviews: costs.length,
    totalCostUsd: total,
    avgCostUsd: costs.length ? total / costs.length : 0,
    maxCostUsd: costs.length ? Math.max(...costs) : 0,
    byPhase,
    byModel,
  }
}
