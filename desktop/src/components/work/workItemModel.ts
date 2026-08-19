import type {
  CollaborationSession,
  CollaborationSnapshot,
  CollaborationTask,
  CollaborationTone
} from '@/components/collaboration/collaborationModel'
import type { RoutingProfileId } from '@/lib/routingDecision'
import { sanitizeDisplayText } from './displaySanitizer'
import {
  projectSessionDisposition,
  projectTaskDisposition,
  type WorkAttentionKind
} from './workLifecycleProjection'

export type WorkItemBucket = 'attention' | 'active'

export type WorkPulse = {
  current: string
  progress: string
  outcome: string
}

export type WorkItemTarget = {
  view: 'collaboration' | 'tasks'
  /** Private in-memory navigation token; never render this value. */
  id: string
}

export type WorkItem = {
  key: string
  kind: 'session' | 'task'
  bucket: WorkItemBucket
  source: string
  title: string
  phase: string
  route: string
  routeFacts: {
    modelUid: string
    provider: string
    upstreamModel: string
    provisional: boolean
  }
  /** Advisory lens only; never changes configured dispatch priority. */
  profile: RoutingProfileId
  updatedAt: number
  tone: CollaborationTone
  suggestion: string
  pulse?: WorkPulse
  fingerprint?: string
  attentionKind?: WorkAttentionKind
  target: WorkItemTarget
}

export type WorkDesk = {
  attention: WorkItem[]
  active: WorkItem[]
}

const MAX_DISPLAY_TEXT = 180

function safeText(value: unknown, fallback: string, limit = MAX_DISPLAY_TEXT): string {
  return sanitizeDisplayText(value, fallback, limit)
}

function safeTimestamp(value: number): number {
  return Number.isFinite(value) ? value : 0
}

function route(provider: unknown, model: unknown, fallback: string): string {
  const safeProvider = safeText(provider, '', 80)
  const safeModel = safeText(model, '', 100)
  return safeText([safeProvider, safeModel].filter(Boolean).join(' · '), fallback, 180)
}

function routeFact(value: unknown, emptyValues: string[]): string {
  const current = safeText(value, '', 120)
  return emptyValues.includes(current.toLowerCase()) ? '' : current
}

function sessionRouteFacts(session: CollaborationSession): WorkItem['routeFacts'] {
  return {
    modelUid: routeFact(session.route.modelUid, ['未绑定', '—']),
    provider: routeFact(session.route.provider, ['自动选择', '未知渠道', '—']),
    upstreamModel: routeFact(session.route.upstreamModel, ['未解析', '未知模型', '—']),
    provisional: session.route.provisional
  }
}

function sessionSuggestion(session: CollaborationSession, bucket: WorkItemBucket): string {
  if (session.verification.blocking) return '查看验证阻塞'
  if (session.warning) return '查看失败信号'
  if (session.stale) return '确认是否继续'
  if (bucket === 'active') return '查看协作会话'
  return '查看协作会话'
}

function sessionTone(session: CollaborationSession, bucket: WorkItemBucket): CollaborationTone {
  if (bucket === 'attention')
    return session.stale && !session.warning && !session.verification.blocking ? 'warn' : 'bad'
  return bucket === 'active' ? 'good' : 'muted'
}

function sessionTodoTitle(value: unknown): string {
  const current = safeText(value, '', 160)
  if (!current || current.toLowerCase() === 'none') return ''
  const separator = current.indexOf(':')
  if (separator > 0 && separator <= 48) {
    return safeText(current.slice(separator + 1), '', 140)
  }
  return current
}

function sessionTitle(session: CollaborationSession): string {
  const goal = safeText(session.goal, '', 180)
  if (goal && goal !== '未识别任务目标') return goal
  const todo = sessionTodoTitle(session.todo.current)
  if (todo) return todo
  const source =
    session.surface === 'devin' ? 'Devin' : session.surface === 'codex' ? 'Codex' : 'Agent'
  return `${source} 协作会话`
}

function sessionPulse(session: CollaborationSession): WorkPulse {
  const completed = Math.min(session.todo.completed, session.todo.total)
  return {
    current: sessionTodoTitle(session.todo.current) || safeText(session.phase, '等待状态', 100),
    progress: session.todo.total ? `${completed} / ${session.todo.total} 项完成` : '未提供计划',
    outcome: session.verification.blocking
      ? '验证需要处理'
      : session.failures.lastToolOk === false
        ? '最近工具失败'
        : session.failures.lastToolOk === true
          ? '最近工具成功'
          : session.stale
            ? '等待确认是否继续'
            : '等待下一次活动'
  }
}

function fromSession(session: CollaborationSession, now: number): WorkItem | null {
  const disposition = projectSessionDisposition(session, now)
  if (disposition.kind === 'closed') return null
  const bucket = disposition.kind === 'attention' ? 'attention' : 'active'
  const routeFacts = sessionRouteFacts(session)
  return {
    key: `session:${session.id}`,
    kind: 'session',
    bucket,
    source: safeText(session.surface.toUpperCase(), 'OTHER', 40),
    title: sessionTitle(session),
    phase: safeText(session.phase, '等待状态'),
    route: route(routeFacts.provider, routeFacts.upstreamModel, '路由待确认'),
    routeFacts,
    profile: 'balanced',
    updatedAt: safeTimestamp(session.latestActivityAt),
    tone: sessionTone(session, bucket),
    suggestion: safeText(sessionSuggestion(session, bucket), '查看会话记录'),
    pulse: sessionPulse(session),
    ...(disposition.kind === 'attention'
      ? { fingerprint: disposition.fingerprint, attentionKind: disposition.category }
      : {}),
    target: { view: 'collaboration', id: session.id }
  }
}

function taskTitle(task: CollaborationTask, status: string): string {
  if (task.commandSummary && task.commandSummary !== '未提供任务摘要') {
    return task.commandSummary
  }
  const source =
    task.source.toLowerCase() === 'codex'
      ? 'Codex'
      : task.source.toLowerCase() === 'devin'
        ? 'Devin'
        : task.source.toLowerCase() === 'acp'
          ? 'ACP'
          : 'Agent'
  const state =
    status === 'failed'
      ? '失败'
      : status === 'timed_out'
        ? '超时'
        : status === 'detached' || status === 'transport_lost'
          ? '连接中断'
          : status === 'queued'
            ? '等待执行'
            : status === 'running'
              ? '正在运行'
              : '状态待确认'
  return `${source} 长任务${state}`
}

function taskPhase(task: CollaborationTask, status: string): string {
  if (status === 'failed') return '执行失败'
  if (status === 'timed_out') return '执行超时'
  if (status === 'detached' || status === 'transport_lost') return '连接中断'
  if (status === 'queued') return '等待执行'
  if (status === 'running' && (!task.phase || task.phase === '等待阶段')) return '执行中'
  return task.phase || task.progress
}

function taskPulse(task: CollaborationTask, status: string): WorkPulse {
  const reportedProgress = safeText(task.progress, '', 140)
  const current =
    status === 'failed'
      ? '等待处理'
      : status === 'timed_out'
        ? '等待确认超时原因'
        : status === 'detached' || status === 'transport_lost'
          ? '等待恢复连接'
          : status === 'queued'
            ? '等待执行'
            : reportedProgress && reportedProgress !== '暂无进度'
              ? reportedProgress
              : status === 'running'
                ? '正在运行'
                : safeText(task.phase, '等待任务更新', 140)
  const attemptProgress = task.attempts.length
    ? `已尝试 ${task.attempts.length} 次`
    : '尚未记录尝试'
  const progress =
    status === 'running' ? '运行中' : status === 'queued' ? '等待执行' : attemptProgress
  const outcome =
    status === 'failed'
      ? '需要查看失败原因'
      : status === 'timed_out'
        ? '需要确认超时原因'
        : status === 'detached' || status === 'transport_lost'
          ? '需要恢复连接'
          : task.result.status === 'succeeded' || task.result.status === 'completed'
            ? '已完成'
            : status === 'running'
              ? attemptProgress
              : '等待下一次活动'
  return {
    current,
    progress: safeText(progress, '状态待确认', 80),
    outcome: safeText(outcome, '等待下一次活动', 80)
  }
}

function fromTask(task: CollaborationTask, now: number): WorkItem | null {
  const status = task.status.toLowerCase()
  const disposition = projectTaskDisposition(task, now)
  if (disposition.kind === 'closed') return null
  const bucket = disposition.kind === 'attention' ? 'attention' : 'active'
  const disconnected = status === 'detached' || status === 'transport_lost'
  const attempt = task.attempts.at(-1)
  const routeFacts: WorkItem['routeFacts'] = {
    modelUid: '',
    provider: routeFact(attempt?.provider, ['未知渠道', '—']),
    upstreamModel: routeFact(attempt?.model, ['未知模型', '—']),
    provisional: false
  }
  return {
    key: `task:${task.jobId}`,
    kind: 'task',
    bucket,
    source: safeText(task.source.toUpperCase(), 'UNKNOWN', 40),
    title: safeText(taskTitle(task, status), '未命名任务'),
    phase: safeText(taskPhase(task, status), '等待状态'),
    route: route(routeFacts.provider, routeFacts.upstreamModel, '尚未选择渠道'),
    routeFacts,
    profile: 'balanced',
    updatedAt: safeTimestamp(task.updatedAt),
    tone:
      bucket === 'attention'
        ? disconnected
          ? 'warn'
          : 'bad'
        : bucket === 'active'
          ? 'good'
          : 'muted',
    suggestion: safeText(
      bucket === 'attention'
        ? disconnected
          ? '检查连接后再处理'
          : '查看失败与交接'
        : bucket === 'active'
          ? '查看任务详情'
          : '审阅任务产物',
      '查看任务详情'
    ),
    pulse: taskPulse(task, status),
    ...(disposition.kind === 'attention'
      ? { fingerprint: disposition.fingerprint, attentionKind: disposition.category }
      : {}),
    target: { view: 'tasks', id: task.jobId }
  }
}

export function emptyWorkDesk(): WorkDesk {
  return { attention: [], active: [] }
}

export function buildWorkDesk(
  snapshot: CollaborationSnapshot,
  tasks: CollaborationTask[],
  now = Date.now()
): WorkDesk {
  const desk = emptyWorkDesk()
  const items = [
    ...snapshot.sessions.map((session) => fromSession(session, now)),
    ...tasks.map((task) => fromTask(task, now))
  ].filter((item): item is WorkItem => item !== null)
  for (const item of items) desk[item.bucket].push(item)
  desk.attention.sort((left, right) => {
    const severity = (item: WorkItem) => (item.tone === 'bad' ? 2 : item.tone === 'warn' ? 1 : 0)
    return severity(right) - severity(left) || right.updatedAt - left.updatedAt
  })
  desk.active.sort((left, right) => right.updatedAt - left.updatedAt)
  return desk
}
