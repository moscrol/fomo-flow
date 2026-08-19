import { sanitizeDisplayText } from '@/components/work/displaySanitizer'
import type { RoutingProfileId } from '@/lib/routingDecision'

export type DecisionCandidate = {
  provider: string
  model: string
  source: string
  actualPriority: number | null
  advisoryRank: number | null
  estimatedCostUsd: number | null
}

export type DecisionExclusion = DecisionCandidate & {
  reason: 'missing_provider' | 'disabled' | 'circuit_open' | 'incompatible'
  reasonLabel: string
}

export type DecisionPreflight = {
  profile: RoutingProfileId
  strategy: 'priority' | 'random'
  configuredOrder: DecisionCandidate[]
  dispatchOrder: DecisionCandidate[]
  excluded: DecisionExclusion[]
  advisoryOrder: DecisionCandidate[]
  budget: {
    status: string
    capUsd: number | null
    fallback: 'strict' | 'cheapest' | null
    overBudgetFallback: boolean
  }
  warnings: Array<{ code: string; message: string }>
  message: string
}

export type DecisionInboxItem = {
  id: string
  classification: string
  severity: 'urgent' | 'warning' | 'review'
  title: string
  message: string
  status: 'open' | 'acknowledged' | 'snoozed'
  count: number
  lastSeenAt: string
  snoozedUntil: string | null
  evidenceId: string | null
}

export type RouteEvidenceEvent = {
  kind: 'plan' | 'plan_drift' | 'attempt' | 'fallback' | 'skip' | 'outcome'
  at: string
  provider: string
  model: string
  status: number | null
  durationMs: number | null
  reasonLabel: string
  outcomeLabel: string
}

export type RouteEvidence = {
  id: string
  createdAt: string
  linkedPreflight: boolean
  plan: Pick<
    DecisionPreflight,
    | 'profile'
    | 'strategy'
    | 'configuredOrder'
    | 'dispatchOrder'
    | 'excluded'
    | 'advisoryOrder'
    | 'budget'
  >
  events: RouteEvidenceEvent[]
  outcome: { status: string; label: string; provider: string; model: string } | null
}

export type DecisionModelOption = {
  value: string
  label: string
  provider: string
  model: string
}

export type DecisionCenterSummary = {
  tone: 'good' | 'warning' | 'danger'
  title: string
  message: string
  openCount: number
  latestRoute: string
  latestOutcome: string
}

export type DecisionPreflightSummary = {
  tone: 'good' | 'warning' | 'danger'
  title: string
  message: string
}

const PROFILES = new Set<RoutingProfileId>([
  'balanced',
  'coding',
  'fast',
  'cheap',
  'reliable',
  'offline'
])

const EXCLUSION_LABELS = {
  missing_provider: '渠道不存在',
  disabled: '渠道已停用',
  circuit_open: '渠道暂时熔断',
  incompatible: '与本次能力要求不兼容'
} as const

const INBOX_COPY: Record<
  string,
  { severity: DecisionInboxItem['severity']; title: string; message: string }
> = {
  budget_rejected: {
    severity: 'urgent',
    title: '本次预算不够',
    message: '所有已知渠道都超过严格预算，需要提高预算或手动调整配置。'
  },
  all_unavailable: {
    severity: 'urgent',
    title: '当前没有可用渠道',
    message: '配置里的渠道都被停用、缺失、不兼容或暂时熔断。'
  },
  exhausted: {
    severity: 'urgent',
    title: '这次所有渠道都失败了',
    message: '请查看路由证据，再决定是否修改渠道或预算。'
  },
  repeated_fallback: {
    severity: 'warning',
    title: '首选渠道没有接住请求',
    message: '请求使用了后备渠道，规定优先级没有被自动修改。'
  },
  advisory_divergence: {
    severity: 'review',
    title: '参考建议与规定顺序不同',
    message: '建议只供比较；是否调整优先级仍由你决定。'
  },
  budget_unverified: {
    severity: 'review',
    title: '预算暂时无法核实',
    message: '至少一个候选缺少价格信息，FOMO FLOW 没有猜测成本。'
  },
  plan_drift: {
    severity: 'warning',
    title: '预演后路由事实发生变化',
    message: '实际发送时的渠道资格与预演不同，请查看证据。'
  }
}

const WARNING_COPY: Record<string, string> = {
  all_unavailable: '当前没有可尝试的渠道',
  budget_rejected: '所有已知渠道都超过本次预算',
  budget_unverified: '部分渠道缺少价格，暂时无法验证预算'
}

const OUTCOME_COPY: Record<string, string> = {
  selected: '已选中渠道',
  budget_rejected: '预算阻止了发送',
  exhausted: '所有渠道都失败了'
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function rows(value: unknown, limit: number): unknown[] {
  return Array.isArray(value) ? value.slice(0, limit) : []
}

function safe(value: unknown, limit = 120): string {
  return sanitizeDisplayText(value, '', limit)
}

function finite(value: unknown, minimum = Number.NEGATIVE_INFINITY): number | null {
  if (value === null || value === undefined || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) && number >= minimum ? number : null
}

function positiveInteger(value: unknown): number | null {
  const number = finite(value, 1)
  return number !== null && Number.isInteger(number) ? number : null
}

function profile(value: unknown): RoutingProfileId {
  const normalized = safe(value, 20).toLowerCase() as RoutingProfileId
  return PROFILES.has(normalized) ? normalized : 'balanced'
}

function candidate(value: unknown): DecisionCandidate {
  const item = record(value)
  return {
    provider: safe(item.provider, 100),
    model: safe(item.model, 100),
    source: safe(item.source, 40),
    actualPriority: positiveInteger(item.actualPriority),
    advisoryRank: positiveInteger(item.advisoryRank),
    estimatedCostUsd: finite(item.estimatedCostUsd, 0)
  }
}

function exclusion(value: unknown): DecisionExclusion {
  const item = record(value)
  const reason = Object.prototype.hasOwnProperty.call(EXCLUSION_LABELS, String(item.reason))
    ? (String(item.reason) as keyof typeof EXCLUSION_LABELS)
    : 'incompatible'
  return { ...candidate(item), reason, reasonLabel: EXCLUSION_LABELS[reason] }
}

function budget(value: unknown): DecisionPreflight['budget'] {
  const item = record(value)
  return {
    status: safe(item.status, 40) || 'not_requested',
    capUsd: finite(item.capUsd, 0),
    fallback: item.fallback === 'strict' || item.fallback === 'cheapest' ? item.fallback : null,
    overBudgetFallback: item.overBudgetFallback === true
  }
}

function plan(value: unknown): Omit<DecisionPreflight, 'message' | 'warnings'> {
  const item = record(value)
  return {
    profile: profile(item.profile),
    strategy: item.strategy === 'random' ? 'random' : 'priority',
    configuredOrder: rows(item.configuredOrder, 20).map(candidate),
    dispatchOrder: rows(item.dispatchOrder, 20).map(candidate),
    excluded: rows(item.excluded, 20).map(exclusion),
    advisoryOrder: rows(item.advisoryOrder, 20).map(candidate),
    budget: budget(item.budget)
  }
}

export function projectPreflight(payload: unknown): DecisionPreflight | null {
  const root = record(payload)
  if (root.ok !== true) return null
  const rawPlan = record(root.plan)
  const projected = plan(rawPlan)
  const warnings = rows(rawPlan.warnings, 10).flatMap((value) => {
    const code = safe(record(value).code, 40)
    return WARNING_COPY[code] ? [{ code, message: WARNING_COPY[code] }] : []
  })
  return {
    ...projected,
    warnings,
    message: '只是预演，不会发送请求或改变优先级。'
  }
}

export function projectDecisionInbox(payload: unknown): DecisionInboxItem[] {
  const root = record(payload)
  return rows(root.items, 50).flatMap((value) => {
    const item = record(value)
    const classification = safe(item.classification, 40)
    const copy = INBOX_COPY[classification]
    const id = safe(item.id, 64)
    if (!copy || !/^decision-[a-f0-9]{24}$/.test(id)) return []
    const status =
      item.status === 'acknowledged' || item.status === 'snoozed' ? item.status : 'open'
    const evidenceId = safe(item.evidenceId, 64)
    return [
      {
        id,
        classification,
        ...copy,
        status,
        count: Math.max(1, Math.min(1_000_000, positiveInteger(item.count) ?? 1)),
        lastSeenAt: safe(item.lastSeenAt, 40),
        snoozedUntil: safe(item.snoozedUntil, 40) || null,
        evidenceId: /^evidence-[a-f0-9]{24}$/.test(evidenceId) ? evidenceId : null
      }
    ]
  })
}

function event(value: unknown): RouteEvidenceEvent {
  const item = record(value)
  const kind = ['plan', 'plan_drift', 'attempt', 'fallback', 'skip', 'outcome'].includes(
    String(item.kind)
  )
    ? (String(item.kind) as RouteEvidenceEvent['kind'])
    : 'attempt'
  const reason = safe(item.reason ?? item.failureClass, 40)
  const status = finite(item.status, 100)
  const outcome = safe(item.status, 40)
  return {
    kind,
    at: safe(item.at, 40),
    provider: safe(item.provider, 100),
    model: safe(item.model, 100),
    status: status !== null && status <= 599 ? status : null,
    durationMs: finite(item.durationMs, 0),
    reasonLabel: EXCLUSION_LABELS[reason as keyof typeof EXCLUSION_LABELS] || '',
    outcomeLabel: OUTCOME_COPY[outcome] || ''
  }
}

export function projectRouteEvidence(payload: unknown): RouteEvidence[] {
  const root = record(payload)
  return rows(root.evidence, 50).flatMap((value) => {
    const item = record(value)
    const id = safe(item.id, 64)
    if (!/^evidence-[a-f0-9]{24}$/.test(id)) return []
    const projectedPlan = plan(item.plan)
    const rawOutcome = record(item.outcome)
    const outcomeStatus = safe(rawOutcome.status, 40)
    return [
      {
        id,
        createdAt: safe(item.createdAt, 40),
        linkedPreflight: Boolean(safe(item.linkedPreflightPlanId, 96)),
        plan: projectedPlan,
        events: rows(item.events, 20).map(event),
        outcome: outcomeStatus
          ? {
              status: outcomeStatus,
              label: OUTCOME_COPY[outcomeStatus] || '结果未知',
              provider: safe(rawOutcome.provider, 100),
              model: safe(rawOutcome.model, 100)
            }
          : null
      }
    ]
  })
}

export function projectDecisionModelOptions(payload: unknown): DecisionModelOption[] {
  const routes = record(record(payload).routes)
  const options = new Map<string, DecisionModelOption>()
  for (const [rawUid, value] of Object.entries(routes)) {
    const uid = safe(rawUid, 120)
    if (!uid || uid.includes('[路径已隐藏]') || options.has(uid)) continue
    const route = record(value)
    const providerName = safe(route.provider ?? route.providerName, 100)
    const modelName = safe(route.model ?? route.upstreamModel, 120)
    const routeName = [providerName, modelName].filter(Boolean).join(' / ')
    options.set(uid, {
      value: uid,
      label: routeName ? `${uid} · ${routeName}` : uid,
      provider: providerName,
      model: modelName
    })
  }
  return [...options.values()]
    .sort((left, right) => left.value.localeCompare(right.value))
    .slice(0, 100)
}

export function summarizeDecisionCenter(
  inbox: DecisionInboxItem[],
  evidence: RouteEvidence[]
): DecisionCenterSummary {
  const openItems = inbox.filter((item) => item.status === 'open')
  const severityOrder: Record<DecisionInboxItem['severity'], number> = {
    urgent: 0,
    warning: 1,
    review: 2
  }
  const leadingItem = [...openItems].sort(
    (left, right) => severityOrder[left.severity] - severityOrder[right.severity]
  )[0]
  const latest = evidence[0]
  const latestRoute = latest?.outcome ? candidateDisplayName(latest.outcome) : '还没有真实请求记录'
  const latestOutcome = latest?.outcome?.label || (latest ? '结果尚未记录' : '暂无')

  if (!leadingItem) {
    return {
      tone: 'good',
      title: '目前正常',
      message: '没有发现需要人工处理的路由问题。',
      openCount: 0,
      latestRoute,
      latestOutcome
    }
  }

  return {
    tone: leadingItem.severity === 'urgent' ? 'danger' : 'warning',
    title: `有 ${openItems.length} 项需要处理`,
    message: `${leadingItem.title}：${leadingItem.message}`,
    openCount: openItems.length,
    latestRoute,
    latestOutcome
  }
}

export function summarizePreflight(preflight: DecisionPreflight): DecisionPreflightSummary {
  if (preflight.budget.status === 'strict_rejected') {
    return {
      tone: 'danger',
      title: '当前预算会阻止发送',
      message: '所有已知候选都超过你选择的严格预算。'
    }
  }

  const firstDispatch = preflight.dispatchOrder[0]
  if (!firstDispatch) {
    return {
      tone: 'danger',
      title: '当前没有可尝试的渠道',
      message: '请查看被排除的渠道及原因。'
    }
  }

  if (preflight.excluded.length > 0) {
    return {
      tone: 'warning',
      title: `预计先走 ${candidateDisplayName(firstDispatch)}`,
      message: `有 ${preflight.excluded.length} 个渠道本次不会尝试。`
    }
  }

  const firstConfigured = preflight.configuredOrder[0]
  const matchesPriority = Boolean(
    firstConfigured &&
    firstConfigured.provider === firstDispatch.provider &&
    firstConfigured.model === firstDispatch.model
  )
  return {
    tone: matchesPriority ? 'good' : 'warning',
    title: `预计先走 ${candidateDisplayName(firstDispatch)}`,
    message: matchesPriority
      ? '与规定优先级一致。'
      : '预计尝试顺序与规定优先级不同，请查看详细顺序。'
  }
}

function candidateDisplayName(value: { provider: string; model: string }): string {
  return [value.provider, value.model].filter(Boolean).join(' · ') || '未命名渠道'
}
