import type {
  CollaborationProvider,
  CollaborationRequest,
  CollaborationSession,
  CollaborationTone
} from './collaborationModel'

const MAX_CHANNELS = 12
const FAILURE_STATUSES = new Set(['failed', 'error', 'timed_out', 'cancelled'])

export type CollaborationChannelHealthItem = {
  provider: string
  sessionCount: number
  requestCount: number
  failureCount: number
  overallP95TtftMs: number | null
  cacheHitP95TtftMs: number | null
  cacheMissP95TtftMs: number | null
  tone: CollaborationTone
  status: string
}

type ChannelAggregate = {
  provider: string
  sessionCount: number
  requestCount: number
  failureCount: number
  overallP95TtftMs: number | null
  cacheHitP95TtftMs: number | null
  cacheMissP95TtftMs: number | null
}

function safeProviderLabel(value: unknown): string {
  const normalized = String(value ?? '未知渠道')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+/gi, '[凭据已隐藏]')
    .replace(/\bsk-[A-Za-z0-9_-]{4,}/gi, '[凭据已隐藏]')
    .replace(
      /(?:file:\/\/)?(?:\/Users\/|\/home\/|\/private\/|\/var\/|\/tmp\/)[^\s,;)}]+/gi,
      '[路径已隐藏]'
    )
    .replace(/[A-Za-z]:\\[^\s,;)}]+/g, '[路径已隐藏]')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100)
  return normalized || '未知渠道'
}

function providerKey(value: unknown): string {
  const normalized = String(value ?? '').trim()
  return normalized || '未知渠道'
}

function numericOrNull(value: number | null): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

function requestFailed(request: CollaborationRequest): boolean {
  return FAILURE_STATUSES.has(request.status.toLocaleLowerCase())
}

function ensureChannel(
  channels: Map<string, ChannelAggregate>,
  rawProvider: unknown
): ChannelAggregate {
  const key = providerKey(rawProvider)
  const existing = channels.get(key)
  if (existing) return existing
  const created: ChannelAggregate = {
    provider: safeProviderLabel(key),
    sessionCount: 0,
    requestCount: 0,
    failureCount: 0,
    overallP95TtftMs: null,
    cacheHitP95TtftMs: null,
    cacheMissP95TtftMs: null
  }
  channels.set(key, created)
  return created
}

function toneFor(channel: ChannelAggregate): CollaborationTone {
  if (channel.failureCount > 0) return 'bad'
  if (channel.sessionCount === 0 && channel.requestCount === 0) return 'muted'
  return 'good'
}

function statusFor(channel: ChannelAggregate): string {
  return `${channel.sessionCount} 个会话 · ${channel.requestCount} 次请求 · ${channel.failureCount} 次失败`
}

export function buildCollaborationChannelHealth(
  providers: CollaborationProvider[],
  sessions: CollaborationSession[],
  recentRequests: CollaborationRequest[]
): CollaborationChannelHealthItem[] {
  const channels = new Map<string, ChannelAggregate>()

  for (const provider of providers) {
    const channel = ensureChannel(channels, provider.id)
    channel.overallP95TtftMs = numericOrNull(provider.latency.overall.p95TtftMs)
    channel.cacheHitP95TtftMs = numericOrNull(provider.latency.cache.hit.p95TtftMs)
    channel.cacheMissP95TtftMs = numericOrNull(provider.latency.cache.miss.p95TtftMs)
  }
  for (const session of sessions) {
    if (session.route.provider !== '自动选择') {
      ensureChannel(channels, session.route.provider).sessionCount += 1
    }
  }
  for (const request of recentRequests) {
    const channel = ensureChannel(channels, request.provider)
    channel.requestCount += 1
    if (requestFailed(request)) channel.failureCount += 1
  }

  return Array.from(channels.values())
    .sort(
      (left, right) =>
        right.failureCount - left.failureCount ||
        right.requestCount - left.requestCount ||
        right.sessionCount - left.sessionCount ||
        left.provider.localeCompare(right.provider)
    )
    .slice(0, MAX_CHANNELS)
    .map((channel) => ({
      ...channel,
      tone: toneFor(channel),
      status: statusFor(channel)
    }))
}
