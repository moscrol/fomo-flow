import type { RoutingDecision } from './routingDecision'

export type ObservabilitySummaryInput = {
  usage: Record<string, unknown>
  alerts: unknown[]
  failures: Record<string, unknown>
  traces: unknown[]
  routingDecisions: RoutingDecision[]
}

export type ObservabilitySummaryAction = {
  label: string
  view: 'hud' | 'providers' | 'routes' | 'collaboration' | 'observability'
}

export type ObservabilitySummaryCard = {
  id: 'status' | 'activity' | 'provider' | 'attention'
  question: string
  headline: string
  detail: string
  tone: 'good' | 'warn' | 'bad' | 'muted'
  action?: ObservabilitySummaryAction
}

export type ObservabilitySummary = {
  status: {
    label: string
    detail: string
    tone: 'good' | 'warn' | 'bad' | 'muted'
  }
  cards: ObservabilitySummaryCard[]
  technicalLabels: Record<string, string>
}

const technicalLabels: Record<string, string> = {
  ttft: '首字响应速度',
  ttftP95: '最慢的 5% 请求',
  cacheHit: '复用成功',
  cacheMiss: '没复用上',
  failureClass: '失败原因',
  advisoryRank: '建议顺序',
  advisoryScore: '参考分（不改变真实路由）',
  actualPriority: '实际优先级',
  channelStrategy: '当前选路方式',
  budgetOverride: '本次请求是否因为预算临时改道'
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function count(value: unknown): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0
}

function text(value: unknown, fallback = '—'): string {
  if (typeof value !== 'string' || !value.trim()) return fallback
  return value.trim().slice(0, 80)
}

function percent(value: number): string {
  return `${Math.round(value * 10) / 10}%`
}

function usageRows(
  usage: Record<string, unknown>
): Array<{ name: string; calls: number; hitRate: number | null }> {
  return Object.entries(usage)
    .filter(([key, value]) => key !== 'totals' && value && typeof value === 'object')
    .map(([name, value]) => {
      const row = record(value)
      const rawHitRate = Number(row.hitRate)
      return {
        name: text(name, '未知渠道'),
        calls: count(row.calls),
        hitRate: Number.isFinite(rawHitRate) ? Math.max(0, Math.min(100, rawHitRate)) : null
      }
    })
    .filter((row) => row.calls > 0)
}

function failureRows(
  failures: Record<string, unknown>
): Array<{ name: string; total: number; kind: string }> {
  const stats = record(failures.stats ?? failures)
  return Object.entries(stats)
    .map(([name, value]) => {
      const row = record(value)
      const kinds = record(row.kinds)
      const firstKind = Object.entries(kinds).sort(
        (left, right) => count(record(right[1]).count) - count(record(left[1]).count)
      )[0]
      return {
        name: text(name, '未知渠道'),
        total: count(row.total),
        kind: firstKind ? text(firstKind[0], '其他问题') : '其他问题'
      }
    })
    .filter((row) => row.total > 0)
    .sort((left, right) => right.total - left.total)
}

function totals(usage: Record<string, unknown>, providers: Array<{ calls: number }>): number {
  const explicit = record(usage.totals)
  const calls = count(explicit.calls)
  return calls > 0 ? calls : providers.reduce((sum, provider) => sum + provider.calls, 0)
}

export function summarizeObservability(input: ObservabilitySummaryInput): ObservabilitySummary {
  const providers = usageRows(input.usage)
  const failures = failureRows(input.failures)
  const totalCalls = totals(input.usage, providers)
  const failureCount = failures.reduce((sum, row) => sum + row.total, 0)
  const warningCount = input.alerts.filter((item) => {
    const level = text(
      record(item).level || record(item).severity || record(item).type,
      ''
    ).toLowerCase()
    return level === 'warn' || level === 'warning'
  }).length
  const errorCount = input.alerts.filter((item) => {
    const level = text(
      record(item).level || record(item).severity || record(item).type,
      ''
    ).toLowerCase()
    return level === 'error' || level === 'failed'
  }).length
  const isEmpty =
    totalCalls === 0 && failureCount === 0 && input.alerts.length === 0 && input.traces.length === 0
  const status = isEmpty
    ? {
        label: '还没有数据',
        detail: '发起一轮 Devin、Codex 或 ACP 请求后，这里会显示运行结论。',
        tone: 'muted' as const
      }
    : errorCount > 0 || failureCount >= 3
      ? {
          label: '需要处理',
          detail: '最近有失败或错误告警，建议先查看问题原因。',
          tone: 'bad' as const
        }
      : failureCount > 0 || warningCount > 0
        ? {
            label: '有需要注意的地方',
            detail: '请求仍在工作，但有少量失败或变慢记录。',
            tone: 'warn' as const
          }
        : {
            label: '整体正常',
            detail: '最近没有发现需要立即处理的问题。',
            tone: 'good' as const
          }
  const successCalls = Math.max(0, totalCalls - failureCount)
  const topProvider = [...providers].sort((left, right) => right.calls - left.calls)[0]
  const topFailure = failures[0]
  const firstAlert = record(input.alerts[0])
  const alertProvider = text(firstAlert.provider || firstAlert.channel || firstAlert.title, '')
  const attentionProvider = topFailure?.name || alertProvider || '当前渠道'

  const cards: ObservabilitySummaryCard[] = [
    {
      id: 'status',
      question: '现在正常吗？',
      headline: status.label,
      detail: status.detail,
      tone: status.tone,
      action: isEmpty
        ? { label: '发起一轮请求', view: 'hud' }
        : { label: '打开实时情况', view: 'hud' }
    },
    {
      id: 'activity',
      question: '刚刚发生了什么？',
      headline: totalCalls > 0 ? `${totalCalls} 次请求` : '还没有请求',
      detail:
        totalCalls > 0
          ? `成功 ${successCalls} 次，失败 ${failureCount} 次。${failureCount === 0 ? '目前不需要处理。' : '失败请求已单独列出。'}`
          : '发起一轮请求后，这里会告诉你成功和失败的数量。',
      tone: failureCount > 0 ? 'warn' : 'muted',
      action: { label: '打开请求记录', view: 'hud' }
    },
    {
      id: 'provider',
      question: '哪个渠道在工作？',
      headline: topProvider ? `${topProvider.name} 最常用` : '还没有渠道数据',
      detail: topProvider
        ? `${topProvider.calls} 次请求${topProvider.hitRate == null ? '' : `；${percent(topProvider.hitRate)} 请求复用成功`}。`
        : '先接入一个渠道并发起请求，这里会显示实际使用情况。',
      tone: topProvider ? 'good' : 'muted',
      action: { label: topProvider ? '查看接入渠道' : '去接入渠道', view: 'providers' }
    },
    {
      id: 'attention',
      question: '要不要处理？',
      headline: topFailure ? `${attentionProvider} 值得看一下` : '暂时不用处理',
      detail: topFailure
        ? `${attentionProvider} 最近有 ${topFailure.total} 次失败，主要原因是“${topFailure.kind}”。建议先查看原因。`
        : '没有高优先级问题。需要排查时，可以展开下面的技术细节。',
      tone: topFailure ? 'warn' : 'good',
      action: topFailure
        ? { label: '查看原因', view: 'observability' }
        : { label: '发起一轮请求', view: 'hud' }
    }
  ]

  return { status, cards, technicalLabels }
}
