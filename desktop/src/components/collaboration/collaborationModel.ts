import { asArray, asRecord } from '@/lib/daoControlApi'

export type CollaborationTone = 'good' | 'warn' | 'bad' | 'muted' | 'brand'

export type CollaborationSurface = 'acp' | 'codex' | 'devin' | 'other'

export type CollaborationSession = {
  id: string
  surface: CollaborationSurface
  active: boolean
  requestInFlight: boolean
  lifecycle: string
  mode: string
  identityKind: string
  warning: boolean
  stale: boolean
  goal: string
  phase: string
  workspace: string
  latestActivityAt: number
  route: {
    provider: string
    modelUid: string
    upstreamModel: string
    provisional: boolean
  }
  telemetry: {
    ttftMs: number | null
    durationMs: number | null
    modelPath: string
    loopSource: string
    reasoningTokens: number
    compactions: number
  }
  cache: {
    observed: boolean
    calls: number
    cached: number
    cacheWrite: number
    hitRate: number
  }
  todo: { completed: number; total: number; current: string }
  verification: { status: string; blocking: boolean }
  failures: {
    maxConsecutive: number
    sameCallStreak: number
    lastToolOk: boolean | null
    hasLastError: boolean
  }
}

export type CollaborationRequest = {
  id: string
  at: number
  provider: string
  model: string
  source: string
  status: string
  ttftMs: number | null
  durationMs: number | null
  cached: number
  input: number
  output: number
  cacheStatus: string
  cacheMode: string
  attemptCount: number
  committedAttempt: number | null
  responseToolCount: number
  firstSignalKind: 'text' | 'tool' | 'none'
  errorCategory: string
  usageObserved: boolean
  warmup: boolean
  success: boolean
}

export type CollaborationLatency = {
  p50TtftMs: number | null
  p95TtftMs: number | null
}

export type CollaborationProvider = {
  id: string
  latency: {
    overall: CollaborationLatency
    cache: { hit: CollaborationLatency; miss: CollaborationLatency }
  }
}

export type CollaborationActivityKind =
  'lifecycle' | 'route' | 'tool' | 'progress' | 'result' | 'unknown'

export type CollaborationActivityTone = CollaborationTone

export type CollaborationActivityFilter = 'all' | 'lifecycle' | 'operation' | 'result'

export type CollaborationActivityRaw = Record<string, boolean | number | string | null>

export type CollaborationActivityItem = {
  id: string
  at: number
  sessionId: string
  turnId: string
  kind: CollaborationActivityKind
  verb: string
  object: string
  outcome: string
  tone: CollaborationActivityTone
  detail: string
  repeatCount: number
  raw: CollaborationActivityRaw
}

export type CollaborationArtifact = { ref: string; kind: string }

export type CollaborationAttempt = {
  provider: string
  model: string
  fallbackUsed: boolean
  fallbackReason: string
  toolCallCount: number
  durationMs: number
  errorCategory: string
  at: number
}

export type CollaborationTaskResult = {
  status: string
  exitCode: number | null
  errorCategory: string
  stdoutSummary: string
  stderrSummary: string
  finishedAt: number
  artifacts: CollaborationArtifact[]
}

export type CollaborationTask = {
  jobId: string
  source: string
  taskType: string
  workspace: string
  targetWorkspace: string
  commandSummary: string
  status: string
  phase: string
  progress: string
  createdAt: number
  updatedAt: number
  lastHeartbeatAt: number | null
  recoveryReason: string
  attempts: CollaborationAttempt[]
  result: CollaborationTaskResult
}

export type CollaborationTaskCounts = {
  total: number
  queued: number
  running: number
  detached: number
  failed: number
  succeeded: number
  other: number
}

export type CollaborationSnapshot = {
  generatedAt: number
  sessions: CollaborationSession[]
  providers: CollaborationProvider[]
  recentRequests: CollaborationRequest[]
  runtime: { healthy: boolean; mode: string; port: number; connection: string }
}

const MAX_TEXT = 220

function text(value: unknown, fallback = '', limit = MAX_TEXT): string {
  if (value === null || value === undefined) return fallback
  const normalized = String(value)
    .replaceAll('\u0000', ' ')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit)
  return normalized || fallback
}

function sessionGoal(value: unknown): string {
  const normalized = text(value, '未识别任务目标')
  if (
    /^You are continuing work from a previous conversation thread\b/i.test(normalized) ||
    /^Below is a summary of the previous conversation thread\b/i.test(normalized)
  ) {
    return '未识别任务目标'
  }
  return normalized
}

function numberValue(value: unknown, fallback = 0): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

function optionalNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
}

function booleanValue(value: unknown): boolean {
  return value === true
}

function surface(value: unknown): CollaborationSurface {
  const normalized = text(value, 'other', 30).toLocaleLowerCase()
  if (normalized === 'acp' || normalized === 'codex' || normalized === 'devin') return normalized
  return 'other'
}

function basename(value: unknown): string {
  const normalized = text(value, '', 600).replaceAll('\\', '/')
  if (!normalized) return '未标记工作区'
  const parts = normalized.split('/').filter(Boolean)
  return text(parts[parts.length - 1], '未标记工作区', 100)
}

function artifactRef(value: unknown): string {
  const raw = text(value, '', 600).replaceAll('\\', '/')
  if (!raw) return ''
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    try {
      const url = new URL(raw)
      const segments = url.pathname.split('/').filter(Boolean)
      return text(segments[segments.length - 1] || url.hostname, '交接产物', 120)
    } catch {
      return basename(raw)
    }
  }
  return basename(raw)
}

function normalizeAttempt(value: unknown): CollaborationAttempt {
  const row = asRecord(value)
  return {
    provider: text(row.provider, '未知渠道', 100),
    model: text(row.model, '未知模型', 100),
    fallbackUsed: booleanValue(row.fallbackUsed),
    fallbackReason: text(row.fallbackReason, '', 120),
    toolCallCount: Math.round(numberValue(row.toolCallCount)),
    durationMs: Math.round(numberValue(row.durationMs)),
    errorCategory: text(row.errorCategory, '', 80),
    at: numberValue(row.at)
  }
}

function normalizeArtifact(value: unknown): CollaborationArtifact {
  const row = typeof value === 'string' ? { ref: value } : asRecord(value)
  return {
    ref: artifactRef(row.ref || row.path || row.url),
    kind: text(row.kind, '', 40)
  }
}

function normalizeResult(value: unknown): CollaborationTaskResult {
  const row = asRecord(value)
  return {
    status: text(row.status, 'unknown', 40),
    exitCode:
      row.exitCode === null || row.exitCode === undefined
        ? null
        : Math.round(numberValue(row.exitCode)),
    errorCategory: text(row.errorCategory, '', 80),
    stdoutSummary: text(row.stdoutSummary || row.stdout, '', MAX_TEXT),
    stderrSummary: text(row.stderrSummary || row.stderr, '', MAX_TEXT),
    finishedAt: numberValue(row.finishedAt),
    artifacts: asArray(row.artifacts)
      .slice(0, 20)
      .map(normalizeArtifact)
      .filter((item) => item.ref)
  }
}

export function normalizeTask(value: unknown): CollaborationTask {
  const row = asRecord(value)
  const attempts = asArray(row.attempts).slice(-8).map(normalizeAttempt)
  return {
    jobId: text(row.jobId || row.id, 'unknown-task', 96),
    source: text(row.source, 'unknown', 40),
    taskType: text(row.taskType || row.type, '未命名任务', 90),
    workspace: basename(row.workspace),
    targetWorkspace: basename(row.targetWorkspace || row.workspace),
    commandSummary: text(row.commandSummary || row.command, '未提供任务摘要'),
    status: text(row.status, 'unknown', 40).toLocaleLowerCase(),
    phase: text(row.phase, '等待阶段', 80),
    progress: text(row.progress, '暂无进度'),
    createdAt: numberValue(row.createdAt),
    updatedAt: numberValue(row.updatedAt),
    lastHeartbeatAt: optionalNumber(row.lastHeartbeatAt),
    recoveryReason: text(row.recoveryReason, '', 100),
    attempts,
    result: normalizeResult(row.result)
  }
}

export function normalizeTasks(value: unknown): {
  tasks: CollaborationTask[]
  counts: CollaborationTaskCounts
} {
  const source = Array.isArray(value) ? value : asArray(asRecord(value).tasks)
  const tasks = source.map(normalizeTask).sort((left, right) => right.updatedAt - left.updatedAt)
  return { tasks, counts: taskCounts(tasks) }
}

export function normalizeCollaborationSnapshot(value: unknown): CollaborationSnapshot {
  const row = asRecord(value)
  const sessions = asArray(row.sessions).map(normalizeSession).sort(sessionSort)
  const providers = asArray(row.providers).map(normalizeProvider)
  const recentRequests = asArray(row.recentRequests)
    .map(normalizeRequest)
    .sort((left, right) => right.at - left.at)
  const runtime = asRecord(row.runtime)
  return {
    generatedAt: numberValue(row.generatedAt),
    sessions,
    providers,
    recentRequests,
    runtime: {
      healthy: booleanValue(runtime.healthy),
      mode: text(runtime.mode, 'unknown', 40),
      port: Math.round(numberValue(runtime.port)),
      connection: text(runtime.connection, 'offline', 40)
    }
  }
}

function normalizeLatency(value: unknown): CollaborationLatency {
  const row = asRecord(value)
  return {
    p50TtftMs: optionalNumber(row.p50TtftMs),
    p95TtftMs: optionalNumber(row.p95TtftMs)
  }
}

function normalizeProvider(value: unknown): CollaborationProvider {
  const row = asRecord(value)
  const latency = asRecord(row.latency)
  const cache = asRecord(latency.cache)
  return {
    id: text(row.id, 'unknown-provider', 100),
    latency: {
      overall: normalizeLatency(latency.overall),
      cache: {
        hit: normalizeLatency(cache.hit),
        miss: normalizeLatency(cache.miss)
      }
    }
  }
}

function normalizeSession(value: unknown): CollaborationSession {
  const row = asRecord(value)
  const route = asRecord(row.route)
  const telemetry = asRecord(row.telemetry)
  const cache = asRecord(row.cache)
  const todo = asRecord(row.todo)
  const verification = asRecord(row.verification)
  const failures = asRecord(row.failures)
  return {
    id: text(row.id, 'unknown-session', 80),
    surface: surface(row.surface),
    active: booleanValue(row.active),
    requestInFlight: booleanValue(row.requestInFlight),
    lifecycle: text(row.lifecycle, 'unknown', 40),
    mode: text(row.mode, 'auto', 32),
    identityKind: text(row.identityKind, 'derived', 32),
    warning: booleanValue(row.warning),
    stale: booleanValue(row.stale),
    goal: sessionGoal(row.goal),
    phase: text(row.phase, '未知阶段', 80),
    workspace: basename(row.workspace),
    latestActivityAt: numberValue(row.latestActivityAt),
    route: {
      provider: text(route.provider, '自动选择', 100),
      modelUid: text(route.modelUid, '未绑定', 120),
      upstreamModel: text(route.upstreamModel, '未解析', 120),
      provisional: booleanValue(route.provisional)
    },
    telemetry: {
      ttftMs: optionalNumber(telemetry.ttftMs),
      durationMs: optionalNumber(telemetry.durationMs),
      modelPath: text(telemetry.modelPath, 'unknown', 60),
      loopSource: text(telemetry.loopSource, 'unknown', 60),
      reasoningTokens: Math.round(numberValue(telemetry.reasoningTokens)),
      compactions: Math.round(numberValue(telemetry.compactions))
    },
    cache: {
      observed: booleanValue(cache.observed),
      calls: Math.round(numberValue(cache.calls)),
      cached: Math.round(numberValue(cache.cached)),
      cacheWrite: Math.round(numberValue(cache.cacheWrite)),
      hitRate: numberValue(cache.hitRate)
    },
    todo: {
      completed: Math.round(numberValue(todo.completed)),
      total: Math.round(numberValue(todo.total)),
      current: text(todo.current, '没有结构化待办', 180)
    },
    verification: {
      status: text(verification.status, 'unknown', 40),
      blocking: booleanValue(verification.blocking)
    },
    failures: {
      maxConsecutive: Math.round(numberValue(failures.maxConsecutive)),
      sameCallStreak: Math.round(numberValue(failures.sameCallStreak)),
      lastToolOk:
        failures.lastToolOk === true ? true : failures.lastToolOk === false ? false : null,
      hasLastError: booleanValue(failures.hasLastError)
    }
  }
}

function normalizeRequest(value: unknown): CollaborationRequest {
  const row = asRecord(value)
  const success = row.success === true
  const explicitStatus = text(row.status, '', 40).toLocaleLowerCase()
  return {
    id: text(row.id, 'request', 80),
    at: numberValue(row.at),
    provider: text(row.provider, '未知渠道', 100),
    model: text(row.model, '未知模型', 100),
    source: text(row.source, 'external', 40),
    status:
      explicitStatus ||
      (row.success === true ? 'succeeded' : row.success === false ? 'failed' : 'observed'),
    ttftMs: optionalNumber(row.ttftMs),
    durationMs: optionalNumber(row.durationMs),
    cached: Math.round(numberValue(row.cached)),
    input: Math.round(numberValue(row.input)),
    output: Math.round(numberValue(row.output)),
    cacheStatus: text(row.cacheStatus, 'unknown', 30).toLocaleLowerCase(),
    cacheMode: text(row.cacheMode, 'off', 30),
    attemptCount: Math.max(1, Math.round(numberValue(row.attemptCount, 1))),
    committedAttempt:
      row.committedAttempt === null || row.committedAttempt === undefined
        ? null
        : Math.max(0, Math.round(numberValue(row.committedAttempt))),
    responseToolCount: Math.round(numberValue(row.responseToolCount)),
    firstSignalKind:
      row.firstSignalKind === 'text' || row.firstSignalKind === 'tool'
        ? row.firstSignalKind
        : 'none',
    errorCategory: text(row.errorCategory, '', 60),
    usageObserved: booleanValue(row.usageObserved),
    warmup: booleanValue(row.warmup),
    success
  }
}

const ACTIVITY_LIMIT = 80
const ACTIVITY_TEXT_LIMIT = 180

function redactActivityText(value: unknown, fallback = '', limit = ACTIVITY_TEXT_LIMIT): string {
  if (value === null || value === undefined) return fallback
  const normalized = String(value)
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+/gi, '[凭据已隐藏]')
    .replace(/\bsk-[A-Za-z0-9_-]{4,}/gi, '[凭据已隐藏]')
    .replace(/(?:file:\/\/)?(?:\/Users\/|\/home\/|\/var\/|\/tmp\/)[^\s,;)}]+/gi, '[路径已隐藏]')
    .replace(/[A-Za-z]:\\[^\s,;)}]+/g, '[路径已隐藏]')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit)
  return normalized || fallback
}

function activityRaw(entries: Record<string, unknown>): CollaborationActivityRaw {
  const raw: CollaborationActivityRaw = {}
  for (const [key, value] of Object.entries(entries)) {
    if (typeof value === 'boolean' || typeof value === 'number' || value === null) {
      raw[key] = value
    } else if (typeof value === 'string') {
      raw[key] = redactActivityText(value, '', 120)
    }
  }
  return raw
}

function activityToneForRequest(request: CollaborationRequest): CollaborationActivityTone {
  if (request.success) return 'good'
  if (
    request.errorCategory ||
    ['failed', 'error', 'timeout', 'timed_out'].includes(request.status)
  ) {
    return 'bad'
  }
  return 'muted'
}

function requestOutcome(request: CollaborationRequest): string {
  if (request.success) return '成功'
  if (
    request.errorCategory ||
    ['failed', 'error', 'timeout', 'timed_out'].includes(request.status)
  ) {
    return request.errorCategory
      ? `失败 · ${redactActivityText(request.errorCategory, '上游错误', 60)}`
      : '失败'
  }
  return '结果未知'
}

function requestRelatedToSession(
  request: CollaborationRequest,
  session: CollaborationSession
): boolean {
  return request.source.toLocaleLowerCase() === session.surface
}

function activityDetailForRequest(request: CollaborationRequest): string {
  const details = [
    request.attemptCount > 1 ? `${request.attemptCount} 次尝试` : '',
    request.responseToolCount > 0 ? `${request.responseToolCount} 次工具信号` : '',
    request.ttftMs !== null ? `TTFT ${formatDuration(request.ttftMs)}` : '',
    request.durationMs !== null ? `耗时 ${formatDuration(request.durationMs)}` : '',
    request.cacheStatus === 'hit' ? '缓存命中' : request.cacheStatus === 'miss' ? '缓存未命中' : '',
    request.errorCategory ? redactActivityText(request.errorCategory, '', 60) : ''
  ].filter(Boolean)
  return details.join(' · ') || '暂无更多安全观测'
}

function activityKey(item: CollaborationActivityItem): string {
  return [item.sessionId, item.kind, item.verb, item.object, item.outcome].join('\u0000')
}

function mergeAdjacentActivities(items: CollaborationActivityItem[]): CollaborationActivityItem[] {
  const chronological = [...items].sort(
    (left, right) => left.at - right.at || left.id.localeCompare(right.id)
  )
  const merged: CollaborationActivityItem[] = []
  const byKey = new Map<string, CollaborationActivityItem>()
  for (const item of chronological) {
    const previous = byKey.get(activityKey(item))
    if (previous) {
      previous.repeatCount += item.repeatCount
      previous.at = Math.max(previous.at, item.at)
      previous.detail = item.detail || previous.detail
      previous.raw = item.raw
      continue
    }
    const copy = { ...item, raw: { ...item.raw } }
    merged.push(copy)
    byKey.set(activityKey(copy), copy)
  }
  return merged
    .sort((left, right) => right.at - left.at || right.id.localeCompare(left.id))
    .slice(0, ACTIVITY_LIMIT)
}

export function buildCollaborationActivity(
  session: CollaborationSession,
  requests: CollaborationRequest[]
): CollaborationActivityItem[] {
  const items: CollaborationActivityItem[] = []
  const lifecycleOutcome = session.warning
    ? '需要关注'
    : session.stale
      ? '无响应'
      : session.active
        ? '进行中'
        : '已结束'
  const lifecycleTone: CollaborationActivityTone = session.warning
    ? 'bad'
    : session.stale
      ? 'warn'
      : session.active
        ? 'good'
        : 'muted'
  items.push({
    id: `${session.id}:lifecycle`,
    at: session.latestActivityAt,
    sessionId: session.id,
    turnId: '',
    kind: 'lifecycle',
    verb: session.active ? '运行' : '结束',
    object: redactActivityText(session.goal, '会话'),
    outcome: lifecycleOutcome,
    tone: lifecycleTone,
    detail: [
      redactActivityText(session.phase, '未知阶段'),
      session.requestInFlight ? '请求进行中' : '',
      session.verification.blocking ? '验证阻塞' : ''
    ]
      .filter(Boolean)
      .join(' · '),
    repeatCount: 1,
    raw: activityRaw({
      lifecycle: session.lifecycle,
      phase: session.phase,
      active: session.active,
      warning: session.warning,
      stale: session.stale,
      workspace: session.workspace,
      verification: session.verification.status
    })
  })

  if (session.todo.total > 0 || session.todo.current !== '没有结构化待办') {
    const progressOutcome = session.todo.total
      ? `${Math.min(session.todo.completed, session.todo.total)}/${session.todo.total}`
      : '进行中'
    items.push({
      id: `${session.id}:progress`,
      at: session.latestActivityAt,
      sessionId: session.id,
      turnId: '',
      kind: 'progress',
      verb: '推进',
      object: redactActivityText(session.todo.current, '待办'),
      outcome: progressOutcome,
      tone: session.warning ? 'bad' : session.active ? 'brand' : 'muted',
      detail: '结构化待办投影',
      repeatCount: 1,
      raw: activityRaw({
        completed: session.todo.completed,
        total: session.todo.total,
        current: session.todo.current
      })
    })
  }

  const routeObject = [session.route.provider, session.route.upstreamModel]
    .map((value) => redactActivityText(value, '未解析', 90))
    .filter(Boolean)
    .join(' → ')
  if (routeObject) {
    items.push({
      id: `${session.id}:route`,
      at: session.latestActivityAt,
      sessionId: session.id,
      turnId: '',
      kind: 'route',
      verb: '路由',
      object: routeObject,
      outcome: session.route.provisional ? '选择中' : '已绑定',
      tone: session.route.provisional ? 'warn' : 'brand',
      detail: session.route.modelUid
        ? `模型 UID ${redactActivityText(session.route.modelUid, '未绑定', 90)}`
        : '未绑定模型 UID',
      repeatCount: 1,
      raw: activityRaw({
        provider: session.route.provider,
        upstreamModel: session.route.upstreamModel,
        modelUid: session.route.modelUid,
        provisional: session.route.provisional
      })
    })
  }

  for (const request of requests
    .filter((item) => requestRelatedToSession(item, session))
    .slice(0, 40)) {
    const requestObject = `${redactActivityText(request.provider, '未知渠道', 80)} · ${redactActivityText(request.model, '未知模型', 100)}`
    const requestDetail = activityDetailForRequest(request)
    const requestTone = activityToneForRequest(request)
    const requestRaw = activityRaw({
      status: request.status,
      provider: request.provider,
      model: request.model,
      attempts: request.attemptCount,
      tools: request.responseToolCount,
      cacheStatus: request.cacheStatus,
      errorCategory: request.errorCategory || null,
      usageObserved: request.usageObserved
    })

    items.push({
      id: `${session.id}:${request.id}:route`,
      at: request.at,
      sessionId: session.id,
      turnId: request.id,
      kind: request.responseToolCount > 0 || request.firstSignalKind === 'tool' ? 'tool' : 'route',
      verb: request.responseToolCount > 0 || request.firstSignalKind === 'tool' ? '调用' : '请求',
      object: requestObject,
      outcome:
        request.responseToolCount > 0
          ? `${request.responseToolCount} 次工具信号`
          : request.cacheStatus === 'hit'
            ? '缓存命中'
            : request.cacheStatus === 'miss'
              ? '已发送'
              : '已观测',
      tone: request.responseToolCount > 0 ? (request.success ? 'good' : requestTone) : 'brand',
      detail: requestDetail,
      repeatCount: 1,
      raw: requestRaw
    })
    items.push({
      id: `${session.id}:${request.id}:result`,
      at: request.at,
      sessionId: session.id,
      turnId: request.id,
      kind: 'result',
      verb: '完成',
      object: requestObject,
      outcome: requestOutcome(request),
      tone: requestTone,
      detail: requestDetail,
      repeatCount: 1,
      raw: requestRaw
    })
  }

  return mergeAdjacentActivities(items)
}

export function activityFilterLabel(filter: CollaborationActivityFilter): string {
  return { all: '全部', lifecycle: '生命周期', operation: '路由 / 工具', result: '结果' }[filter]
}

export function activityKindLabel(kind: CollaborationActivityKind): string {
  return {
    lifecycle: '生命周期',
    route: '路由',
    tool: '工具',
    progress: '进度',
    result: '结果',
    unknown: '未知'
  }[kind]
}

export function activityMatchesFilter(
  item: CollaborationActivityItem,
  filter: CollaborationActivityFilter
): boolean {
  if (filter === 'all') return true
  if (filter === 'lifecycle') return item.kind === 'lifecycle'
  if (filter === 'result') return item.kind === 'result'
  return item.kind === 'route' || item.kind === 'tool' || item.kind === 'progress'
}

function sessionSort(left: CollaborationSession, right: CollaborationSession): number {
  return (
    Number(right.active) - Number(left.active) ||
    Number(right.warning) - Number(left.warning) ||
    right.latestActivityAt - left.latestActivityAt
  )
}

export function taskCounts(tasks: CollaborationTask[]): CollaborationTaskCounts {
  const counts: CollaborationTaskCounts = {
    total: tasks.length,
    queued: 0,
    running: 0,
    detached: 0,
    failed: 0,
    succeeded: 0,
    other: 0
  }
  for (const task of tasks) {
    if (task.status === 'queued') counts.queued += 1
    else if (task.status === 'running') counts.running += 1
    else if (task.status === 'detached' || task.status === 'transport_lost') counts.detached += 1
    else if (task.status === 'failed' || task.status === 'timed_out' || task.status === 'cancelled')
      counts.failed += 1
    else if (task.status === 'succeeded') counts.succeeded += 1
    else counts.other += 1
  }
  return counts
}

export function surfaceLabel(value: CollaborationSurface): string {
  return { acp: 'ACP', codex: 'CODEX', devin: 'DEVIN', other: 'OTHER' }[value]
}

export function taskStatusLabel(status: string): string {
  return (
    {
      queued: '等待中',
      running: '运行中',
      detached: '已脱离',
      transport_lost: '传输中断',
      succeeded: '已完成',
      failed: '失败',
      timed_out: '超时',
      cancelled: '已取消',
      unknown: '未知'
    }[status] ||
    status ||
    '未知'
  )
}

export function taskTone(status: string): CollaborationTone {
  if (status === 'running' || status === 'succeeded') return 'good'
  if (status === 'queued' || status === 'detached' || status === 'transport_lost') return 'warn'
  if (status === 'failed' || status === 'timed_out' || status === 'cancelled') return 'bad'
  return 'muted'
}

export function sessionTone(session: CollaborationSession): CollaborationTone {
  if (session.warning) return 'bad'
  if (session.active) return 'good'
  if (session.stale) return 'warn'
  return 'muted'
}

export function formatRelativeAge(now: number, at: number | null): string {
  if (!at || !now || at > now) return '刚刚'
  const seconds = Math.floor((now - at) / 1_000)
  if (seconds < 60) return `${seconds} 秒前`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  return `${hours} 小时前`
}

export function formatDuration(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—'
  if (value < 1_000) return `${Math.round(value)} ms`
  return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)} s`
}
