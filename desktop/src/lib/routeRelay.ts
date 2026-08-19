import { sanitizeDisplayText } from '@/components/work/displaySanitizer'

export type RouteRelayCircuitCategory =
  | 'authentication'
  | 'balance'
  | 'permission'
  | 'model_not_found'
  | 'rate_limit'
  | 'transient'
  | 'upstream_5xx'
  | 'network'
  | 'unknown'

export type RouteRelayHop = {
  provider: string
  model: string
  actualPriority: number
  state: 'ready' | 'skipped' | 'blocked'
  dispatchPosition: number | null
  reasonLabel: string
  circuitCategory: RouteRelayCircuitCategory | null
  circuitLabel: string
  remainingMs: number | null
}

const MAX_HOPS = 20
const MAX_REMAINING_MS = 24 * 60 * 60 * 1_000

const REASON_LABELS = {
  missing_provider: '渠道不存在',
  disabled: '渠道已停用',
  circuit_open: '渠道暂时熔断',
  incompatible: '与本次能力要求不兼容'
} as const

const CIRCUIT_LABELS: Record<RouteRelayCircuitCategory, string> = {
  authentication: '凭据需要处理',
  balance: '余额或配额不足',
  permission: '渠道权限不足',
  model_not_found: '上游没有这个模型',
  rate_limit: '上游限流',
  transient: '上游暂时繁忙',
  upstream_5xx: '上游服务异常',
  network: '网络连接失败',
  unknown: '渠道暂时不可用'
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function rows(value: unknown): unknown[] {
  return Array.isArray(value) ? value.slice(0, MAX_HOPS) : []
}

function text(value: unknown, limit = 120): string {
  return sanitizeDisplayText(value, '', limit)
}

function positiveInteger(value: unknown, fallback: number): number {
  const number = Number(value)
  return Number.isInteger(number) && number > 0 ? number : fallback
}

function key(value: unknown, fallbackPriority: number): string {
  const item = record(value)
  return [
    text(item.provider, 100),
    text(item.model, 100),
    positiveInteger(item.actualPriority, fallbackPriority)
  ].join('|')
}

function circuitCategory(value: unknown): RouteRelayCircuitCategory {
  const normalized = text(value, 40) as RouteRelayCircuitCategory
  return Object.prototype.hasOwnProperty.call(CIRCUIT_LABELS, normalized) ? normalized : 'unknown'
}

function remainingMs(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const number = Number(value)
  if (!Number.isFinite(number) || number < 0) return null
  return Math.min(MAX_REMAINING_MS, number)
}

export function projectRouteRelay(payload: unknown): RouteRelayHop[] {
  const plan = record(record(payload).plan)
  const budgetBlocked = text(record(plan.budget).status, 40) === 'strict_rejected'
  const configured = rows(plan.configuredOrder)
  const dispatchPositions = new Map(
    rows(plan.dispatchOrder).map((value, index) => [key(value, index + 1), index + 1])
  )
  const exclusions = new Map(
    rows(plan.excluded).map((value, index) => [key(value, index + 1), record(value)])
  )

  return configured.map((value, index) => {
    const item = record(value)
    const actualPriority = positiveInteger(item.actualPriority, index + 1)
    const itemKey = key(item, actualPriority)
    const excluded = exclusions.get(itemKey)
    const reason = text(excluded?.reason, 40) as keyof typeof REASON_LABELS
    const isCircuit = reason === 'circuit_open'
    const category = isCircuit ? circuitCategory(excluded?.circuitCategory) : null
    const state = excluded ? 'skipped' : budgetBlocked ? 'blocked' : 'ready'

    return {
      provider: text(item.provider, 100),
      model: text(item.model, 100),
      actualPriority,
      state,
      dispatchPosition: state === 'ready' ? (dispatchPositions.get(itemKey) ?? null) : null,
      reasonLabel:
        state === 'blocked'
          ? '严格预算阻止发送'
          : excluded
            ? (REASON_LABELS[reason] ?? '本次不可尝试')
            : '',
      circuitCategory: category,
      circuitLabel: category ? CIRCUIT_LABELS[category] : '',
      remainingMs: isCircuit ? remainingMs(excluded?.remainingMs) : null
    }
  })
}

export function formatRelayRecovery(value: number | null): string {
  if (value === null || !Number.isFinite(value) || value < 0) return ''
  const seconds = Math.max(1, Math.ceil(value / 1_000))
  if (seconds < 60) return `约 ${seconds} 秒后可再尝试`
  const minutes = Math.floor(seconds / 60)
  const remainder = seconds % 60
  return remainder > 0
    ? `约 ${minutes} 分 ${remainder} 秒后可再尝试`
    : `约 ${minutes} 分钟后可再尝试`
}
