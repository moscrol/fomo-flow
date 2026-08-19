import { asRecord } from '@/lib/daoControlApi'

export type DisplayTone = 'good' | 'warn' | 'bad' | 'muted'

export function finiteValue(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

export function formatCount(value: unknown): string {
  const parsed = finiteValue(value)
  if (parsed === null) return '—'
  return Math.max(0, Math.round(parsed)).toLocaleString('zh-CN')
}

export function formatTokens(value: unknown): string {
  const parsed = finiteValue(value)
  if (parsed === null) return '—'
  const absolute = Math.abs(parsed)
  if (absolute >= 1_000_000) return `${(parsed / 1_000_000).toFixed(2).replace(/\.00$/, '')}M`
  if (absolute >= 1_000) return `${(parsed / 1_000).toFixed(1).replace(/\.0$/, '')}K`
  return Math.round(parsed).toLocaleString('zh-CN')
}

export function formatPercent(value: unknown): string {
  const parsed = finiteValue(value)
  return parsed === null ? '—' : `${Math.round(parsed)}%`
}

export function formatCost(value: unknown, currency = 'USD'): string {
  const parsed = finiteValue(value)
  if (parsed === null) return '—'
  const prefix = currency.toUpperCase() === 'USD' ? '$' : ''
  return `${prefix}${parsed.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')}${
    currency && currency.toUpperCase() !== 'USD' ? ` ${currency}` : ''
  }`
}

export function formatDate(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—'
  const date = new Date(typeof value === 'number' ? value : String(value))
  if (Number.isNaN(date.getTime())) return String(value)
  return date.toLocaleString('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })
}

export function protocolLabel(value: unknown): string {
  const protocol = String(value || '').trim()
  return (
    (
      {
        'openai-chat': 'OpenAI Chat',
        'openai-responses': 'OpenAI Responses',
        anthropic: 'Anthropic',
        gemini: 'Gemini'
      } as Record<string, string>
    )[protocol] ||
    protocol ||
    '自动协议'
  )
}

export function capabilityOf(value: unknown): Record<string, unknown> {
  const record = asRecord(value)
  return asRecord(record.capabilities || record)
}

export function capabilityBadges(value: unknown): string[] {
  const capability = capabilityOf(value)
  const badges: string[] = []
  if (capability.supportsThinking === true) {
    const levels = Array.isArray(capability.reasoningLevels) ? capability.reasoningLevels.length : 0
    badges.push(levels ? `思考 ${levels} 档` : '支持思考')
  } else if (capability.supportsThinking === false) {
    badges.push('无思考')
  }
  if (capability.supportsTools === true) badges.push('工具兼容')
  if (capability.supportsTools === false) badges.push('工具风险')
  const context = finiteValue(capability.contextTokens)
  if (context !== null) badges.push(`上下文 ${formatTokens(context)}`)
  return badges
}

export function healthState(
  value: unknown,
  builtin = false
): {
  label: string
  tone: DisplayTone
} {
  if (builtin) return { label: '内置验证通路', tone: 'good' }
  const health = asRecord(value)
  if (health.alive === true || health.ok === true || health.state === 'healthy') {
    return { label: '已连通', tone: 'good' }
  }
  if (health.alive === false || health.ok === false || health.state === 'failed') {
    return { label: '探活失败', tone: 'bad' }
  }
  return { label: '待探活', tone: 'muted' }
}

export function usageOf(value: unknown): Record<string, unknown> {
  return asRecord(asRecord(value).usage)
}

export function usageLine(value: unknown): string {
  const usage = usageOf(value)
  const calls = finiteValue(usage.calls)
  if (calls === null || calls <= 0) return '尚无真实请求'
  const total = formatTokens(usage.total)
  const input = formatTokens(usage.input)
  const output = formatTokens(usage.output)
  const cost =
    usage.cost === undefined ? '' : ` · ${formatCost(usage.cost, String(usage.currency || 'USD'))}`
  return `${formatCount(calls)} 次 · ${total} tok（入 ${input} / 出 ${output}）${cost}`
}

export function cacheLine(value: unknown): string {
  const usage = usageOf(value)
  const recent = asRecord(usage.recent)
  const recentCalls = finiteValue(recent.calls)
  const hitRateValue = finiteValue(usage.hitRate)
  const cachedValue = finiteValue(usage.cached)
  if (hitRateValue === null && cachedValue === null && recentCalls === null) return '缓存暂无样本'
  const hitRate = formatPercent(usage.hitRate)
  const cached = formatTokens(usage.cached)
  const recentText =
    recentCalls && recentCalls > 0
      ? ` · 近 ${formatCount(recentCalls)} 次 ${formatPercent(recent.hitRate)}`
      : ''
  return `缓存 ${hitRate} · ${cached} tok${recentText}`
}
