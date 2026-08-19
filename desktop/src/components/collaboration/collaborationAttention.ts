import {
  formatRelativeAge,
  type CollaborationSession,
  type CollaborationTone
} from './collaborationModel'

const MAX_ATTENTION_ITEMS = 12

export type CollaborationAttentionKind = 'blocked' | 'failed' | 'stale' | 'watch'

export type CollaborationAttentionItem = {
  sessionId: string
  kind: CollaborationAttentionKind
  title: string
  detail: string
  suggestion: string
  tone: CollaborationTone
  priority: number
  at: number
}

function safeText(value: unknown, fallback = '未标记', limit = 180): string {
  if (value === null || value === undefined) return fallback
  const normalized = String(value)
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
    .replace(/^[#>*-]+\s*/, '')
    .slice(0, limit)
  return normalized || fallback
}

function failedSession(session: CollaborationSession): boolean {
  return Boolean(
    session.warning ||
    session.failures.hasLastError ||
    session.failures.lastToolOk === false ||
    session.failures.maxConsecutive > 0 ||
    session.failures.sameCallStreak > 0
  )
}

function staleSession(session: CollaborationSession): boolean {
  const lifecycle = session.lifecycle.toLocaleLowerCase()
  return (
    session.stale ||
    (!session.active && ['detached', 'transport_lost', 'disconnected', 'lost'].includes(lifecycle))
  )
}

function buildItem(
  session: CollaborationSession,
  kind: CollaborationAttentionKind,
  now: number
): CollaborationAttentionItem {
  const title = safeText(session.goal, '未识别会话目标')
  const phase = safeText(session.phase, '未知阶段', 100)
  if (kind === 'blocked') {
    return {
      sessionId: session.id,
      kind,
      title,
      detail: `${phase} · 验证阻塞`,
      suggestion: '先检查验证状态，再决定是否交接。',
      tone: 'bad',
      priority: 100,
      at: session.latestActivityAt
    }
  }
  if (kind === 'failed') {
    return {
      sessionId: session.id,
      kind,
      title,
      detail: `${phase} · 失败信号`,
      suggestion: '先审阅失败信号与语义活动，再决定后续动作。',
      tone: 'bad',
      priority: 90,
      at: session.latestActivityAt
    }
  }
  if (kind === 'stale') {
    return {
      sessionId: session.id,
      kind,
      title,
      detail: `${phase} · ${formatRelativeAge(now, session.latestActivityAt)}`,
      suggestion: '先确认心跳与最近活动，再判断是否需要接手。',
      tone: 'warn',
      priority: 70,
      at: session.latestActivityAt
    }
  }
  return {
    sessionId: session.id,
    kind,
    title,
    detail: `${phase} · 请求在途`,
    suggestion: '继续观察在途请求，等待下一次安全状态更新。',
    tone: 'brand',
    priority: 40,
    at: session.latestActivityAt
  }
}

export function buildCollaborationAttention(
  sessions: CollaborationSession[],
  now: number
): CollaborationAttentionItem[] {
  const items = sessions.flatMap((session) => {
    const kind: CollaborationAttentionKind | null = session.verification.blocking
      ? 'blocked'
      : failedSession(session)
        ? 'failed'
        : staleSession(session)
          ? 'stale'
          : session.active && session.requestInFlight
            ? 'watch'
            : null
    return kind ? [buildItem(session, kind, now)] : []
  })
  return items
    .sort(
      (left, right) =>
        right.priority - left.priority ||
        right.at - left.at ||
        left.sessionId.localeCompare(right.sessionId)
    )
    .slice(0, MAX_ATTENTION_ITEMS)
}
