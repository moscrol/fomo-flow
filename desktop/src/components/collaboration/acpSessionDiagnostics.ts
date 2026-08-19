import {
  formatCompact,
  formatInteger,
  formatLatency,
  formatPercent
} from '@/components/control/hud/hudFormatters'

import {
  formatRelativeAge,
  type CollaborationProvider,
  type CollaborationSession,
  type CollaborationTone
} from './collaborationModel'

export type AcpSessionDiagnosticFact = {
  label: string
  value: string
  note: string
  tone: CollaborationTone
}

function upper(value: string, fallback = 'UNKNOWN'): string {
  const normalized = value.trim()
  return normalized ? normalized.toUpperCase() : fallback
}

function verificationTone(session: CollaborationSession): CollaborationTone {
  if (session.verification.blocking) return 'bad'
  const status = session.verification.status.toLocaleLowerCase()
  if (
    ['ok', 'passed', 'verified', 'success', 'succeeded', 'complete', 'completed'].includes(status)
  ) {
    return 'good'
  }
  return 'muted'
}

function failureTone(session: CollaborationSession): CollaborationTone {
  if (
    session.failures.hasLastError ||
    session.failures.lastToolOk === false ||
    session.failures.maxConsecutive > 0 ||
    session.failures.sameCallStreak > 0
  ) {
    return 'bad'
  }
  return 'muted'
}

function failureNote(session: CollaborationSession): string {
  if (session.failures.lastToolOk === true) return '最近工具成功'
  if (session.failures.lastToolOk === false) return '最近工具失败'
  return '工具状态未知'
}

function cacheNote(session: CollaborationSession): string {
  if (!session.cache.observed) return '暂无会话缓存样本'
  return `${formatInteger(session.cache.calls)} 次 · 读 ${formatCompact(session.cache.cached)} · 写 ${formatCompact(session.cache.cacheWrite)}`
}

export function buildAcpSessionDiagnostics(
  session: CollaborationSession,
  provider: CollaborationProvider | undefined,
  now: number
): AcpSessionDiagnosticFact[] {
  const cache = session.cache
  const providerLatency = provider?.latency
  return [
    {
      label: '验证',
      value: upper(session.verification.status),
      note: session.verification.blocking ? '存在完成阻塞' : '无完成阻塞',
      tone: verificationTone(session)
    },
    {
      label: '失败信号',
      value: `${formatInteger(session.failures.maxConsecutive)} MAX · ${formatInteger(session.failures.sameCallStreak)} REPEAT`,
      note: failureNote(session),
      tone: failureTone(session)
    },
    {
      label: '会话缓存',
      value: cache.observed ? formatPercent(cache.hitRate) : '—',
      note: cacheNote(session),
      tone: cache.observed ? 'brand' : 'muted'
    },
    {
      label: '新鲜度',
      value: formatRelativeAge(now, session.latestActivityAt),
      note: `${upper(session.mode, 'AUTO')} · ${session.identityKind}`,
      tone: session.stale ? 'warn' : 'muted'
    },
    {
      label: '推理 Token',
      value: formatCompact(session.telemetry.reasoningTokens),
      note: '当前任务最近一轮',
      tone: 'muted'
    },
    {
      label: '首字延迟',
      value: formatLatency(session.telemetry.ttftMs),
      note: 'TTFT',
      tone: 'muted'
    },
    {
      label: '轮次耗时',
      value: formatLatency(session.telemetry.durationMs),
      note: 'DURATION',
      tone: 'muted'
    },
    {
      label: '渠道 TTFT P50',
      value: formatLatency(providerLatency?.overall.p50TtftMs ?? null),
      note: 'PROVIDER MEDIAN',
      tone: 'muted'
    },
    {
      label: '渠道 TTFT P95',
      value: formatLatency(providerLatency?.overall.p95TtftMs ?? null),
      note: 'PROVIDER TAIL',
      tone: 'muted'
    },
    {
      label: '缓存命中 P95',
      value: formatLatency(providerLatency?.cache.hit.p95TtftMs ?? null),
      note: 'CACHE HIT',
      tone: 'muted'
    },
    {
      label: '缓存未命中 P95',
      value: formatLatency(providerLatency?.cache.miss.p95TtftMs ?? null),
      note: 'CACHE MISS',
      tone: 'muted'
    },
    {
      label: '上下文压缩',
      value: formatInteger(session.telemetry.compactions),
      note: 'COMPACTIONS',
      tone: 'muted'
    },
    {
      label: '模型路径',
      value: upper(session.telemetry.modelPath),
      note: 'CONTROL PLANE',
      tone: 'brand'
    },
    {
      label: '状态来源',
      value: upper(session.telemetry.loopSource),
      note: 'LOOP SOURCE',
      tone: 'muted'
    }
  ]
}
