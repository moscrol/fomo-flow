export type RoutingProfileId = 'balanced' | 'coding' | 'fast' | 'cheap' | 'reliable' | 'offline'

export type RoutingDecisionCandidate = {
  provider: string
  model: string
  source: string
  actualPriority: number | null
  advisoryRank: number | null
  advisoryScore: number | null
  factors: Record<string, number>
}

export type RoutingDecision = {
  id: string
  at: string
  model: string
  channelStrategy: string
  mode: string
  profile: RoutingProfileId
  candidates: RoutingDecisionCandidate[]
  outcome: {
    status: string
    provider: string
    model: string
    actualPriority: number | null
    failureCount: number
  }
  selected: { provider: string; model: string } | null
  budget: {
    status: string
    capUsd: number | null
    fallback: string | null
    budget_override: string | null
    overBudgetFallback: boolean
  }
}

export const ROUTING_PROFILES: Array<{ id: RoutingProfileId; label: string }> = [
  { id: 'balanced', label: '均衡' },
  { id: 'coding', label: '编码' },
  { id: 'fast', label: '低延迟' },
  { id: 'cheap', label: '成本' },
  { id: 'reliable', label: '可靠' },
  { id: 'offline', label: '离线稳态' }
]

export const ROUTING_FACTOR_LABELS: Record<string, string> = {
  health: '健康',
  latency: '延迟',
  cost: '成本',
  cacheAffinity: '缓存',
  stability: '稳定',
  quota: '额度',
  taskFit: '任务',
  priority: '优先'
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function asArray<T = unknown>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : []
}

function asNumber(value: unknown, fallback = 0): number {
  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric : fallback
}

function asNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric : null
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : value == null ? '' : String(value)
}

function normalizeProfile(value: unknown): RoutingProfileId {
  const text = asString(value).toLowerCase()
  return ROUTING_PROFILES.some((profile) => profile.id === text)
    ? (text as RoutingProfileId)
    : 'balanced'
}

function normalizeFactors(value: unknown): Record<string, number> {
  const source = asRecord(value)
  return Object.fromEntries(
    Object.entries(source).map(([key, raw]) => [key, Math.max(0, Math.min(1, asNumber(raw)))])
  )
}

function parseCandidate(value: unknown): RoutingDecisionCandidate {
  const row = asRecord(value)
  const advisoryScore = asNullableNumber(row.advisoryScore)
  return {
    provider: asString(row.provider),
    model: asString(row.model),
    source: asString(row.source),
    actualPriority: asNullableNumber(row.actualPriority),
    advisoryRank: asNullableNumber(row.advisoryRank),
    advisoryScore,
    factors: normalizeFactors(row.factors)
  }
}

export function parseRoutingDecisions(value: unknown): RoutingDecision[] {
  const root = asRecord(value)
  const rows = asArray(root.decisions ?? value)
  return rows.map((item) => {
    const row = asRecord(item)
    const outcome = asRecord(row.outcome)
    const budget = asRecord(row.budget)
    const selected = asRecord(row.selected)
    const outcomePriority = asNullableNumber(outcome.actualPriority)
    const capUsd = asNullableNumber(budget.capUsd)
    return {
      id: asString(row.id),
      at: asString(row.at),
      model: asString(row.model),
      channelStrategy: asString(row.channelStrategy || 'priority'),
      mode: asString(row.mode || 'advisory'),
      profile: normalizeProfile(row.profile),
      candidates: asArray(row.candidates).map(parseCandidate),
      selected:
        selected.provider || selected.model
          ? { provider: asString(selected.provider), model: asString(selected.model) }
          : null,
      outcome: {
        status: asString(outcome.status || 'pending'),
        provider: asString(outcome.provider),
        model: asString(outcome.model),
        actualPriority: outcomePriority,
        failureCount: asNumber(outcome.failureCount)
      },
      budget: {
        status: asString(budget.status || 'not_requested'),
        capUsd,
        fallback: budget.fallback == null ? null : asString(budget.fallback),
        budget_override: budget.budget_override == null ? null : asString(budget.budget_override),
        overBudgetFallback: budget.overBudgetFallback === true
      }
    }
  })
}

export function topRoutingFactors(
  candidate: RoutingDecisionCandidate,
  limit = 3
): Array<{ key: string; label: string; value: number }> {
  return Object.entries(candidate.factors)
    .sort((left, right) => right[1] - left[1])
    .slice(0, limit)
    .map(([key, value]) => ({
      key,
      label: ROUTING_FACTOR_LABELS[key] || key,
      value
    }))
}
