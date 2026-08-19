import type {
  CollaborationSession,
  CollaborationSnapshot,
  CollaborationTask
} from '@/components/collaboration/collaborationModel'
import type { TaskboardWorkItem } from '@/lib/desktopHost'
import type { DecisionInboxItem } from '@/lib/decisionCenter'
import { sanitizeDisplayText } from './displaySanitizer'
import type { WorkItem } from './workItemModel'
import { isTaskFactRecent, projectSessionDisposition } from './workLifecycleProjection'

export type DeskEventKind =
  | 'lifecycle'
  | 'progress'
  | 'request'
  | 'route'
  | 'tool'
  | 'task'
  | 'artifact'
  | 'approval'
  | 'handoff'
  | 'unknown'

export type DeskEventState =
  'running' | 'waiting' | 'success' | 'warning' | 'failure' | 'retired' | 'unknown'

export type DeskEventFilter = 'all' | 'attention' | 'traffic' | 'progress'

export type DeskEvent = {
  key: string
  at: number
  kind: DeskEventKind
  state: DeskEventState
  actor: string
  verb: string
  object: string
  outcome: string
  detail: string
  importance: 'high' | 'normal' | 'quiet'
  source: 'session' | 'request' | 'task' | 'taskboard' | 'decision'
  ownerKey?: string
  evidence: Record<string, boolean | number | string | null>
}

export type DeskEventInput = {
  snapshot: CollaborationSnapshot
  tasks: CollaborationTask[]
  taskboardItems: TaskboardWorkItem[]
  decisions: DecisionInboxItem[]
  now?: number
}

export type WorkCapsule = {
  item: WorkItem
  events: DeskEvent[]
  current: string
  progress: string
  outcome: string
  route: WorkItem['routeFacts']
  task?: CollaborationTask
  hasHandoff: boolean
}

const EVENT_LIMIT = 80

function safe(value: unknown, fallback: string, limit = 180): string {
  return sanitizeDisplayText(value, fallback, limit)
}

function finiteTimestamp(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0
}

function parseTimestamp(value: unknown): number {
  if (typeof value === 'number') return finiteTimestamp(value)
  const parsed = Date.parse(String(value ?? ''))
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0
}

function opaque(parts: Array<string | number>): string {
  const value = parts.join('\u001f')
  let left = 0x811c9dc5
  let right = 0x9e3779b9
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    left = Math.imul(left ^ code, 0x01000193) >>> 0
    right = Math.imul(right ^ (code + index), 0x85ebca6b) >>> 0
  }
  return `${left.toString(16).padStart(8, '0')}${right.toString(16).padStart(8, '0')}`
}

function eventKey(parts: Array<string | number>): string {
  return `event-${opaque(parts)}`
}

export function opaqueWorkOwner(kind: 'session' | 'task', rawId: string): string {
  return `work-${opaque([kind, rawId])}`
}

function surfaceLabel(value: string): string {
  const normalized = value.toLowerCase()
  if (normalized === 'devin') return 'Devin'
  if (normalized === 'codex') return 'Codex'
  if (normalized === 'acp') return 'ACP Agent'
  return 'Agent'
}

function sessionObject(session: CollaborationSession): string {
  const actor = surfaceLabel(session.surface)
  const goal = safe(session.goal, '', 180)
  return goal && goal !== '未识别任务目标' ? goal : `${actor} 协作会话`
}

function taskObject(task: CollaborationTask): string {
  const actor = surfaceLabel(task.source)
  const summary = safe(task.commandSummary, '', 180)
  return summary && summary !== '未提供任务摘要' ? summary : `${actor} 长任务`
}

function sessionEvent(session: CollaborationSession): DeskEvent {
  const failed = session.warning || session.verification.blocking
  const waiting = session.stale || !session.active
  return {
    key: eventKey(['session', session.id, 'lifecycle']),
    ownerKey: opaqueWorkOwner('session', session.id),
    at: finiteTimestamp(session.latestActivityAt),
    kind: 'lifecycle',
    state: failed ? 'failure' : waiting ? 'waiting' : 'running',
    actor: surfaceLabel(session.surface),
    verb: failed ? '遇到阻塞' : waiting ? '等待' : '正在处理',
    object: sessionObject(session),
    outcome: failed ? '需要你处理' : waiting ? '等待下一次活动' : '进行中',
    detail: safe(session.phase, '阶段尚未上报', 100),
    importance: failed ? 'high' : 'normal',
    source: 'session',
    evidence: {
      active: session.active,
      lifecycle: safe(session.lifecycle, 'unknown', 40),
      phase: safe(session.phase, 'unknown', 80),
      provider: safe(session.route.provider, '', 100) || null,
      model: safe(session.route.upstreamModel, '', 120) || null,
      verification: safe(session.verification.status, 'unknown', 40),
      todoCompleted: session.todo.completed,
      todoTotal: session.todo.total,
      cacheObserved: session.cache.observed,
      cacheCalls: session.cache.calls,
      cacheHitRate: session.cache.hitRate,
      lastToolOk: session.failures.lastToolOk
    }
  }
}

function requestEvent(request: CollaborationSnapshot['recentRequests'][number]): DeskEvent {
  const failure = !request.success && Boolean(request.errorCategory)
  const route = [
    safe(request.provider, '未知渠道', 100),
    safe(request.model, '未知模型', 120)
  ].join(' · ')
  const outcome = failure
    ? '请求失败'
    : request.cacheStatus === 'hit'
      ? '缓存命中'
      : request.cacheStatus === 'miss'
        ? '缓存未命中'
        : request.success
          ? '请求成功'
          : '结果待确认'
  return {
    key: eventKey(['request', request.id]),
    at: finiteTimestamp(request.at),
    kind: request.responseToolCount > 0 ? 'tool' : 'request',
    state: failure ? 'failure' : request.success ? 'success' : 'unknown',
    actor: '模型请求',
    verb: request.responseToolCount > 0 ? '调用工具并经过' : '经过',
    object: route,
    outcome,
    detail:
      [
        request.attemptCount > 1 ? `${request.attemptCount} 次尝试` : '',
        request.ttftMs === null ? '' : `首字延迟 ${Math.round(request.ttftMs)} ms`,
        request.durationMs === null ? '' : `总耗时 ${Math.round(request.durationMs)} ms`
      ]
        .filter(Boolean)
        .join(' · ') || '已记录安全请求事实',
    importance: failure ? 'high' : 'quiet',
    source: 'request',
    evidence: {
      provider: safe(request.provider, '未知渠道', 100),
      model: safe(request.model, '未知模型', 120),
      status: safe(request.status, 'unknown', 40),
      cacheStatus: safe(request.cacheStatus, 'unknown', 30),
      attempts: request.attemptCount,
      tools: request.responseToolCount,
      success: request.success
    }
  }
}

function taskEvent(task: CollaborationTask): DeskEvent {
  const status = task.status.toLowerCase()
  const failure = ['failed', 'timed_out', 'detached', 'transport_lost'].includes(status)
  const success = ['succeeded', 'completed'].includes(status)
  const queued = status === 'queued'
  const running = status === 'running'
  const actor = surfaceLabel(task.source)
  const object = taskObject(task)
  return {
    key: eventKey(['task', task.jobId, 'lifecycle']),
    ownerKey: opaqueWorkOwner('task', task.jobId),
    at: Math.max(
      finiteTimestamp(task.updatedAt),
      finiteTimestamp(task.lastHeartbeatAt),
      finiteTimestamp(task.result.finishedAt)
    ),
    kind: 'task',
    state: failure
      ? 'failure'
      : success
        ? 'success'
        : queued
          ? 'waiting'
          : running
            ? 'running'
            : 'unknown',
    actor,
    verb: failure
      ? '执行失败'
      : success
        ? '完成了'
        : queued
          ? '等待执行'
          : running
            ? '正在执行'
            : '状态待确认',
    object,
    outcome: failure
      ? '需要你处理'
      : success
        ? '已完成'
        : queued
          ? '等待中'
          : running
            ? '运行中'
            : '事实类型尚未识别',
    detail: safe(task.phase || task.progress, '阶段尚未上报', 120),
    importance: failure ? 'high' : 'normal',
    source: 'task',
    evidence: {
      status: safe(task.status, 'unknown', 40),
      phase: safe(task.phase, 'unknown', 80),
      attempts: task.attempts.length,
      artifacts: task.result.artifacts.length,
      result: safe(task.result.status, 'unknown', 40)
    }
  }
}

function taskAttemptEvents(task: CollaborationTask): DeskEvent[] {
  const actor = surfaceLabel(task.source)
  const ownerKey = opaqueWorkOwner('task', task.jobId)
  return task.attempts.map((attempt, index) => {
    const failed = Boolean(attempt.errorCategory)
    const fallback = attempt.fallbackUsed && !failed
    return {
      key: eventKey(['task', task.jobId, 'attempt', index]),
      ownerKey,
      at: finiteTimestamp(attempt.at || task.updatedAt),
      kind: 'route',
      state: failed ? 'failure' : fallback ? 'warning' : 'unknown',
      actor,
      verb: '尝试渠道',
      object: `${safe(attempt.provider, '未知渠道', 100)} · ${safe(attempt.model, '未知模型', 120)}`,
      outcome: failed
        ? `失败 · ${safe(attempt.errorCategory, '上游错误', 60)}`
        : fallback
          ? '使用后备渠道'
          : '已记录尝试',
      detail:
        safe(attempt.fallbackReason, '', 120) ||
        (attempt.durationMs > 0 ? `耗时 ${Math.round(attempt.durationMs)} ms` : '已记录路由尝试'),
      importance: failed ? 'high' : 'normal',
      source: 'task',
      evidence: {
        provider: safe(attempt.provider, '未知渠道', 100),
        model: safe(attempt.model, '未知模型', 120),
        fallback: attempt.fallbackUsed,
        durationMs: finiteTimestamp(attempt.durationMs),
        errorCategory: safe(attempt.errorCategory, '', 60) || null,
        tools: attempt.toolCallCount
      }
    } satisfies DeskEvent
  })
}

function taskArtifactEvents(task: CollaborationTask): DeskEvent[] {
  const actor = surfaceLabel(task.source)
  const ownerKey = opaqueWorkOwner('task', task.jobId)
  return task.result.artifacts.map((artifact, index) => ({
    key: eventKey(['task', task.jobId, 'artifact', index]),
    ownerKey,
    at: finiteTimestamp(task.result.finishedAt || task.updatedAt),
    kind: 'artifact',
    state: 'success',
    actor,
    verb: '产出',
    object: safe(artifact.ref, '任务产物', 120),
    outcome: '可审阅',
    detail: safe(artifact.kind, '任务产物', 60),
    importance: 'normal',
    source: 'task',
    evidence: {
      ref: safe(artifact.ref, '任务产物', 120),
      kind: safe(artifact.kind, '任务产物', 60)
    }
  }))
}

function taskboardEvent(item: TaskboardWorkItem): DeskEvent {
  const state =
    item.status === 'blocked' ? 'failure' : item.status === 'in_review' ? 'waiting' : 'running'
  return {
    key: eventKey(['taskboard', item.identifier]),
    at: finiteTimestamp(item.updatedAt),
    kind: 'progress',
    state,
    actor: 'Taskboard',
    verb:
      item.status === 'blocked' ? '标记阻塞' : item.status === 'in_review' ? '等待验收' : '跟踪',
    object: safe(`${item.identifier} · ${item.title}`, '计划事项'),
    outcome:
      item.status === 'blocked' ? '需要你处理' : item.status === 'in_review' ? '待验收' : '进行中',
    detail: safe(item.priority, 'none', 20),
    importance: item.status === 'blocked' ? 'high' : 'normal',
    source: 'taskboard',
    evidence: {
      identifier: safe(item.identifier, '', 40),
      status: item.status,
      priority: item.priority
    }
  }
}

function decisionEvent(item: DecisionInboxItem): DeskEvent {
  return {
    key: eventKey(['decision', item.id]),
    at: parseTimestamp(item.lastSeenAt),
    kind: 'approval',
    state: item.severity === 'urgent' ? 'failure' : 'warning',
    actor: '路由观察',
    verb: '请求确认',
    object: safe(item.title, '路由事项'),
    outcome: '需要你确认',
    detail: safe(item.message, '请查看真实路由证据。'),
    importance: 'high',
    source: 'decision',
    evidence: {
      classification: safe(item.classification, 'unknown', 40),
      severity: item.severity,
      count: item.count,
      status: item.status
    }
  }
}

export function projectDeskEvents({
  snapshot,
  tasks,
  taskboardItems,
  decisions,
  now = Date.now()
}: DeskEventInput): DeskEvent[] {
  const liveSessions = snapshot.sessions.filter(
    (session) => projectSessionDisposition(session, now).kind !== 'closed'
  )
  const liveTasks = tasks.filter((task) => isTaskFactRecent(task, now))
  const events = [
    ...liveSessions.map(sessionEvent),
    ...snapshot.recentRequests.map(requestEvent),
    ...liveTasks.flatMap((task) => [
      taskEvent(task),
      ...taskAttemptEvents(task),
      ...taskArtifactEvents(task)
    ]),
    ...taskboardItems.map(taskboardEvent),
    ...decisions.filter((item) => item.status === 'open').map(decisionEvent)
  ]
  const byKey = new Map<string, DeskEvent>()
  for (const event of events) byKey.set(event.key, event)
  const ordered = [...byKey.values()].sort(
    (left, right) => right.at - left.at || left.key.localeCompare(right.key)
  )
  const retained = new Set(
    ordered
      .filter((event) => event.importance === 'high')
      .slice(0, EVENT_LIMIT)
      .map((event) => event.key)
  )
  for (const event of ordered) {
    if (retained.size >= EVENT_LIMIT) break
    retained.add(event.key)
  }
  return ordered.filter((event) => retained.has(event.key))
}

export function deskEventMatchesFilter(event: DeskEvent, filter: DeskEventFilter): boolean {
  if (filter === 'all') return true
  if (filter === 'attention') return event.importance === 'high'
  if (filter === 'traffic') return ['request', 'route', 'tool'].includes(event.kind)
  return ['lifecycle', 'progress', 'task', 'artifact', 'handoff'].includes(event.kind)
}

export function buildWorkCapsule(
  item: WorkItem,
  events: DeskEvent[],
  task: CollaborationTask | undefined,
  hasHandoff: boolean
): WorkCapsule {
  const ownerKey = opaqueWorkOwner(item.kind, item.target.id)
  const selectedTask = item.kind === 'task' && task?.jobId === item.target.id ? task : undefined
  return {
    item,
    events: events.filter((event) => event.ownerKey === ownerKey),
    current: safe(item.pulse?.current, item.phase, 140),
    progress: safe(item.pulse?.progress, '进度尚未上报', 100),
    outcome: safe(item.pulse?.outcome, '等待下一次活动', 100),
    route: item.routeFacts,
    ...(selectedTask ? { task: selectedTask } : {}),
    hasHandoff
  }
}
