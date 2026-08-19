import type {
  CollaborationSession,
  CollaborationTask
} from '@/components/collaboration/collaborationModel'

export type WorkAttentionKind =
  'failed' | 'timed_out' | 'detached' | 'transport_lost' | 'stale' | 'blocked'

export type LiveWorkDisposition =
  | { kind: 'running'; reason: string }
  | {
      kind: 'attention'
      reason: string
      category: WorkAttentionKind
      fingerprint: string
    }
  | { kind: 'closed'; reason: string }

const TERMINAL_SESSION = new Set(['stopped', 'closed', 'completed', 'cancelled'])
const RUNNING_TASK = new Set(['queued', 'running'])
const ATTENTION_TASK = new Set<WorkAttentionKind>([
  'failed',
  'timed_out',
  'detached',
  'transport_lost'
])
const SESSION_FRESH_MS = 5 * 60 * 1_000
const TASK_FRESH_MS = 5 * 60 * 1_000

function taskLatestFactAt(task: CollaborationTask): number {
  return Math.max(task.updatedAt, task.lastHeartbeatAt ?? 0, task.result.finishedAt)
}

export function isTaskFactRecent(task: CollaborationTask, now = Date.now()): boolean {
  const latestFactAt = taskLatestFactAt(task)
  return latestFactAt > 0 && Math.max(0, now - latestFactAt) <= TASK_FRESH_MS
}

function opaqueFingerprint(parts: Array<string | number>): string {
  const value = parts.join('\u001f')
  let left = 0x811c9dc5
  let right = 0x9e3779b9
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    left = Math.imul(left ^ code, 0x01000193) >>> 0
    right = Math.imul(right ^ (code + index), 0x85ebca6b) >>> 0
  }
  const lane = (seed: number) => (seed >>> 0).toString(16).padStart(8, '0')
  return `${lane(left)}${lane(right)}${lane(left ^ right)}${lane(Math.imul(left, right))}`
}

function attention(
  identity: string,
  category: WorkAttentionKind,
  reason: string,
  facts: Array<string | number>
): LiveWorkDisposition {
  return {
    kind: 'attention',
    reason,
    category,
    fingerprint: opaqueFingerprint([identity, category, ...facts])
  }
}

export function projectSessionDisposition(
  session: CollaborationSession,
  now = Date.now()
): LiveWorkDisposition {
  const lifecycle = session.lifecycle.trim().toLowerCase()
  if (TERMINAL_SESSION.has(lifecycle)) {
    return { kind: 'closed', reason: '会话已结束，详情保留在历史中' }
  }

  const activityAge = session.latestActivityAt
    ? Math.max(0, now - session.latestActivityAt)
    : Number.POSITIVE_INFINITY
  if (activityAge > SESSION_FRESH_MS) {
    return { kind: 'closed', reason: '会话超过 5 分钟无活动，已退出当前工作' }
  }

  if (session.verification.blocking || session.warning) {
    return attention(session.id, 'blocked', '会话存在需要确认的阻塞', [
      session.latestActivityAt,
      session.phase,
      session.verification.status
    ])
  }

  const requestedActive = session.active || session.requestInFlight
  if (lifecycle === 'stale' || session.stale) {
    return attention(session.id, 'stale', '状态可能已过期，请确认连接', [
      session.latestActivityAt,
      session.phase,
      lifecycle
    ])
  }

  if (requestedActive) return { kind: 'running', reason: '协作会话正在运行' }
  return { kind: 'closed', reason: '会话当前没有运行事实' }
}

export function projectTaskDisposition(
  task: CollaborationTask,
  now = Date.now()
): LiveWorkDisposition {
  const status = task.status.trim().toLowerCase()
  if (!isTaskFactRecent(task, now)) {
    return { kind: 'closed', reason: '任务超过 5 分钟无更新，已退出当前工作' }
  }
  if (RUNNING_TASK.has(status)) {
    return { kind: 'running', reason: '任务正在运行' }
  }
  if (ATTENTION_TASK.has(status as WorkAttentionKind)) {
    const category = status as WorkAttentionKind
    const reason =
      category === 'detached' || category === 'transport_lost'
        ? '连接中断，需要确认后续处理'
        : category === 'timed_out'
          ? '任务超时，需要确认后续处理'
          : '任务失败，需要确认后续处理'
    return attention(task.jobId, category, reason, [
      task.updatedAt,
      task.result.finishedAt,
      task.result.errorCategory,
      task.recoveryReason
    ])
  }
  return { kind: 'closed', reason: '任务已退出实时工作桌' }
}
