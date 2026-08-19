import type { RoutingProfileId } from '@/lib/routingDecision'
import { sanitizeDisplayText } from './displaySanitizer'

export type InterventionCandidate = {
  provider: string
  model: string
  score: number | null
  reason: string
  advisoryOnly: true
}

export type InterventionSummary = {
  advisoryOnly: true
  message: string
  profile: RoutingProfileId
  profileSource: 'advisory' | 'default'
  candidates: InterventionCandidate[]
}

const MESSAGE = '仅供比较，不会自动切换。'
const MAX_TEXT = 160
const MAX_SCORE = 1_000_000
const ROUTING_PROFILES = new Set<RoutingProfileId>([
  'balanced',
  'coding',
  'fast',
  'cheap',
  'reliable',
  'offline'
])

function boundedText(value: unknown): string {
  if (typeof value !== 'string' && typeof value !== 'number') return ''
  return sanitizeDisplayText(value, '', MAX_TEXT)
}

function score(value: unknown): number | null {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim()
        ? Number(value)
        : NaN
  if (!Number.isFinite(parsed)) return null
  return Math.max(-MAX_SCORE, Math.min(MAX_SCORE, parsed))
}

function decisionsFrom(payload: unknown): unknown[] {
  if (!payload || typeof payload !== 'object') return []
  const root = payload as Record<string, unknown>
  if (Array.isArray(root.decisions)) return root.decisions
  if (
    root.data &&
    typeof root.data === 'object' &&
    Array.isArray((root.data as Record<string, unknown>).decisions)
  ) {
    return (root.data as Record<string, unknown>).decisions as unknown[]
  }
  return []
}

function advisoryProfile(value: unknown): {
  profile: RoutingProfileId
  profileSource: 'advisory' | 'default'
} {
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase() as RoutingProfileId
    if (ROUTING_PROFILES.has(normalized)) {
      return { profile: normalized, profileSource: 'advisory' }
    }
  }
  return { profile: 'balanced', profileSource: 'default' }
}

export function buildInterventionSummary(payload: unknown): InterventionSummary {
  const decisions = decisionsFrom(payload)
  const latest =
    decisions[0] && typeof decisions[0] === 'object'
      ? (decisions[0] as Record<string, unknown>)
      : null
  const profile = advisoryProfile(latest?.profile)
  const candidateRows = Array.isArray(latest?.candidates) ? latest.candidates : decisions
  const candidates: InterventionCandidate[] = []
  for (const value of candidateRows) {
    if (!value || typeof value !== 'object') continue
    const decision = value as Record<string, unknown>
    const provider = boundedText(decision.provider ?? decision.providerName)
    const model = boundedText(decision.model ?? decision.modelUid ?? decision.upstreamModel)
    // A candidate without either routing identity is not useful for comparison.
    if (!provider && !model) continue
    const reason = boundedText(decision.reason ?? decision.why ?? decision.explanation)
    candidates.push({
      provider,
      model,
      score: score(decision.advisoryScore ?? decision.score),
      reason,
      advisoryOnly: true
    })
    if (candidates.length === 5) break
  }
  return { advisoryOnly: true, message: MESSAGE, ...profile, candidates }
}
