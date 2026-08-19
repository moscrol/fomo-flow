import type { HudRequest, HudTask } from './hudProjection'

const compactNumber = new Intl.NumberFormat('zh-CN', {
  notation: 'compact',
  maximumFractionDigits: 1
})
const integerNumber = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 })
const timeNumber = new Intl.DateTimeFormat('zh-CN', {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false
})

export function formatCompact(value: number): string {
  return compactNumber.format(value)
}

export function formatInteger(value: number): string {
  return integerNumber.format(value)
}

export function formatPercent(value: number): string {
  return `${value.toFixed(value % 1 ? 1 : 0)}%`
}

export function formatAge(value: number): string {
  if (value < 1_000) return '刚刚'
  if (value < 60_000) return `${Math.floor(value / 1_000)}s`
  if (value < 3_600_000) return `${Math.floor(value / 60_000)}m`
  return `${Math.floor(value / 3_600_000)}h`
}

export function formatTime(value: number): string {
  return value ? timeNumber.format(new Date(value)) : '—'
}

export function formatLatency(value: number | null): string {
  return value === null ? '—' : `${formatInteger(value)} ms`
}

export function requestCacheStatus(request: HudRequest): 'hit' | 'miss' | 'unknown' {
  if (request.cacheStatus === 'hit' || request.cacheStatus === 'miss') return request.cacheStatus
  if (!request.usageObserved) return 'unknown'
  return request.cached > 0 ? 'hit' : 'miss'
}

export function requestState(request: HudRequest): {
  label: string
  tone: 'live' | 'warning' | 'muted'
} {
  if (request.cacheDowngrade) return { label: 'DOWNGRADE', tone: 'warning' }
  if (request.warmup) return { label: 'WARMUP', tone: 'muted' }
  const cacheStatus = requestCacheStatus(request)
  if (cacheStatus === 'hit') return { label: 'HIT', tone: 'live' }
  if (cacheStatus === 'miss') return { label: 'MISS', tone: 'muted' }
  return { label: 'UNKNOWN', tone: 'warning' }
}

export function taskState(task: HudTask): {
  label: string
  tone: 'live' | 'warning' | 'danger' | 'muted'
} {
  const labels: Record<string, string> = {
    queued: '排队',
    running: '运行',
    detached: '已脱离',
    succeeded: '成功',
    failed: '失败',
    timed_out: '超时',
    transport_lost: '传输中断',
    cancelled: '已取消',
    unknown: '未知'
  }
  const tone: Record<string, 'live' | 'warning' | 'danger' | 'muted'> = {
    running: 'live',
    succeeded: 'live',
    detached: 'warning',
    transport_lost: 'warning',
    queued: 'warning',
    failed: 'danger',
    timed_out: 'danger',
    cancelled: 'danger',
    unknown: 'danger'
  }
  return {
    label: labels[task.status] ?? task.status.toUpperCase(),
    tone: tone[task.status] ?? 'warning'
  }
}

export function providerStateLabel(state: string): string {
  if (state === 'circuit-open') return 'CIRCUIT'
  if (state === 'degraded') return 'DEGRADED'
  if (state === 'alive') return 'ALIVE'
  return 'UNKNOWN'
}
