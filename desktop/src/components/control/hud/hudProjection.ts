import { asArray, asRecord } from '@/lib/daoControlApi'

export type HudTone = 'live' | 'warning' | 'danger' | 'muted'

export type HudLatency = {
  p50TtftMs: number | null
  p95TtftMs: number | null
}

export type HudRuntime = {
  healthy: boolean
  mode: string
  port: number
  connection: string
  componentWarnings: string[]
  codex: {
    toolSurface: string
    toolSurfaceState: string
    diskToolMode: string
    zeroToolRisk: boolean
  }
}

export type HudTotals = {
  activeSessions: number
  warnings: number
  calls: number
  input: number
  output: number
  cached: number
  cacheWrite: number
  hitRate: number
  openCircuits: number
}

export type HudSession = {
  id: string
  surface: string
  identityKind: string
  mode: string
  active: boolean
  lifecycle: string
  stale: boolean
  warning: boolean
  latestActivityAt: number
  goal: string
  phase: string
  workspace: string
  todo: { completed: number; total: number; current: string }
  verification: { status: string; blocking: boolean }
  failures: {
    maxConsecutive: number
    sameCallStreak: number
    lastToolOk: boolean | null
  }
  route: { modelUid: string; provider: string; upstreamModel: string; provisional: boolean }
  telemetry: {
    reasoningTokens: number
    compactions: number
    ttftMs: number | null
    durationMs: number | null
    modelPath: string
    loopSource: string
  }
  cache: { observed: boolean; calls: number; cached: number; cacheWrite: number; hitRate: number }
}

export type HudProvider = {
  id: string
  state: string
  ageMs: number
  model: string
  calls: number
  hitRate: number
  recentCalls: number
  recentHitRate: number
  latency: { overall: HudLatency; cache: { hit: HudLatency; miss: HudLatency } }
  circuit: { category: string; remainingMs: number } | null
}

export type HudTask = {
  id: string
  source: string
  taskType: string
  status: string
  phase: string
  progress: string
  freshnessMs: number
  attemptCount: number
  fallbackCount: number
  result: { status: string; errorCategory: string }
}

export const HUD_LIVE_TASK_MS = 5 * 60_000

export type HudTaskDesk = {
  live: HudTask[]
  retired: number
}

export function projectHudTaskDesk(tasks: HudTask[]): HudTaskDesk {
  const live = tasks.filter((task) => task.freshnessMs <= HUD_LIVE_TASK_MS)
  return { live, retired: tasks.length - live.length }
}

export type HudRequest = {
  id: string
  at: number
  provider: string
  model: string
  source: string
  cached: number
  cacheWrite: number
  hitRate: number
  cacheMode: string
  cacheTtl: string
  cacheName: string
  cacheStatus: string
  stablePrefixChars: number
  stablePrefixHash: string
  prefixState: string
  prefixGeneration: number
  prefixReason: string
  ttftMs: number | null
  ttftObserved: boolean
  upstreamSemanticMs: number | null
  retryOverheadMs: number | null
  warmup: boolean
  cacheDowngrade: string
  usageObserved: boolean
}

export type HudSnapshot = {
  version: number
  generatedAt: number
  runtime: HudRuntime
  totals: HudTotals
  cachePolicy: { activeWarmups: number; warmupSent: number }
  sessions: HudSession[]
  providers: HudProvider[]
  tasks: HudTask[]
  recentRequests: HudRequest[]
}

export const emptyHudSnapshot: HudSnapshot = {
  version: 0,
  generatedAt: 0,
  runtime: {
    healthy: false,
    mode: 'unknown',
    port: 0,
    connection: 'offline',
    componentWarnings: [],
    codex: {
      toolSurface: 'classic-forced',
      toolSurfaceState: 'unknown',
      diskToolMode: '—',
      zeroToolRisk: false
    }
  },
  totals: {
    activeSessions: 0,
    warnings: 0,
    calls: 0,
    input: 0,
    output: 0,
    cached: 0,
    cacheWrite: 0,
    hitRate: 0,
    openCircuits: 0
  },
  cachePolicy: { activeWarmups: 0, warmupSent: 0 },
  sessions: [],
  providers: [],
  tasks: [],
  recentRequests: []
}

function text(value: unknown, fallback = '—', maxLength = 160): string {
  if (typeof value !== 'string') return fallback
  const normalized = value
    .replaceAll('\u0000', ' ')
    .replaceAll('\n', ' ')
    .replaceAll('\r', ' ')
    .replaceAll('\t', ' ')
    .trim()
  if (!normalized) return fallback
  return normalized.slice(0, maxLength)
}

function finite(value: unknown, fallback = 0): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

function optionalFinite(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
}

function bool(value: unknown): boolean {
  return value === true
}

function latency(value: unknown): HudLatency {
  const record = asRecord(value)
  return {
    p50TtftMs: optionalFinite(record.p50TtftMs),
    p95TtftMs: optionalFinite(record.p95TtftMs)
  }
}

function stringList(value: unknown): string[] {
  return asArray(value)
    .filter((item): item is string => typeof item === 'string')
    .map((item) => text(item, '', 220))
    .filter(Boolean)
}

function sessionFrom(value: unknown): HudSession {
  const row = asRecord(value)
  const todo = asRecord(row.todo)
  const verification = asRecord(row.verification)
  const failures = asRecord(row.failures)
  const route = asRecord(row.route)
  const telemetry = asRecord(row.telemetry)
  const cache = asRecord(row.cache)
  return {
    id: text(row.id, 'unknown', 80),
    surface: text(row.surface, 'agent', 32),
    identityKind: text(row.identityKind, 'derived', 32),
    mode: text(row.mode, 'auto', 32),
    active: bool(row.active),
    lifecycle: text(row.lifecycle, 'unknown', 40),
    stale: bool(row.stale),
    warning: bool(row.warning),
    latestActivityAt: finite(row.latestActivityAt),
    goal: text(row.goal, '当前会话未上报目标', 220),
    phase: text(row.phase, 'unknown', 80),
    workspace: text(row.workspace, 'workspace?', 100),
    todo: {
      completed: finite(todo.completed),
      total: finite(todo.total),
      current: text(todo.current, '没有结构化待办', 180)
    },
    verification: {
      status: text(verification.status, 'unknown', 40),
      blocking: bool(verification.blocking)
    },
    failures: {
      maxConsecutive: finite(failures.maxConsecutive),
      sameCallStreak: finite(failures.sameCallStreak),
      lastToolOk: failures.lastToolOk === true ? true : failures.lastToolOk === false ? false : null
    },
    route: {
      modelUid: text(route.modelUid, '—', 120),
      provider: text(route.provider, '—', 120),
      upstreamModel: text(route.upstreamModel, '—', 120),
      provisional: bool(route.provisional)
    },
    telemetry: {
      reasoningTokens: finite(telemetry.reasoningTokens),
      compactions: finite(telemetry.compactions),
      ttftMs: optionalFinite(telemetry.ttftMs),
      durationMs: optionalFinite(telemetry.durationMs),
      modelPath: text(telemetry.modelPath, 'unknown', 80),
      loopSource: text(telemetry.loopSource, 'unknown', 80)
    },
    cache: {
      observed: bool(cache.observed),
      calls: finite(cache.calls),
      cached: finite(cache.cached),
      cacheWrite: finite(cache.cacheWrite),
      hitRate: finite(cache.hitRate)
    }
  }
}

function providerFrom(value: unknown): HudProvider {
  const row = asRecord(value)
  const latencyRecord = asRecord(row.latency)
  const cache = asRecord(latencyRecord.cache)
  const circuit = asRecord(row.circuit)
  return {
    id: text(row.id, 'unknown', 100),
    state: text(row.state, 'unknown', 40),
    ageMs: finite(row.ageMs),
    model: text(row.model, '尚无实际模型样本', 120),
    calls: finite(row.calls),
    hitRate: finite(row.hitRate),
    recentCalls: finite(row.recentCalls),
    recentHitRate: finite(row.recentHitRate),
    latency: {
      overall: latency(latencyRecord.overall),
      cache: { hit: latency(cache.hit), miss: latency(cache.miss) }
    },
    circuit:
      Object.keys(circuit).length > 0
        ? {
            category: text(circuit.category, 'upstream', 60),
            remainingMs: finite(circuit.remainingMs)
          }
        : null
  }
}

function taskFrom(value: unknown): HudTask {
  const row = asRecord(value)
  const result = asRecord(row.result)
  return {
    id: text(row.id, 'unknown', 100),
    source: text(row.source, 'unknown', 40),
    taskType: text(row.taskType, '未命名任务', 100),
    status: text(row.status, 'unknown', 40),
    phase: text(row.phase, '等待阶段', 80),
    progress: text(row.progress, '未提供进度', 180),
    freshnessMs: finite(row.freshnessMs),
    attemptCount: finite(row.attemptCount),
    fallbackCount: finite(row.fallbackCount),
    result: {
      status: text(result.status, '尚未结束', 60),
      errorCategory: text(result.errorCategory, '', 80)
    }
  }
}

function requestFrom(value: unknown): HudRequest {
  const row = asRecord(value)
  return {
    id: text(row.id, 'unknown', 80),
    at: finite(row.at),
    provider: text(row.provider, '—', 100),
    model: text(row.model, '—', 120),
    source: text(row.source, 'external', 40),
    cached: finite(row.cached),
    cacheWrite: finite(row.cacheWrite),
    hitRate: finite(row.hitRate),
    cacheMode: text(row.cacheMode, 'off', 40),
    cacheTtl: text(row.cacheTtl, 'default', 40),
    cacheName: text(row.cacheName, '—', 120),
    cacheStatus: text(row.cacheStatus, 'unknown', 32),
    stablePrefixChars: finite(row.stablePrefixChars),
    stablePrefixHash: text(row.stablePrefixHash, '', 80),
    prefixState: text(row.prefixState, 'unknown', 32),
    prefixGeneration: finite(row.prefixGeneration),
    prefixReason: text(row.prefixReason, 'insufficient-prefix-evidence', 80),
    ttftMs: optionalFinite(row.ttftMs),
    ttftObserved: bool(row.ttftObserved),
    upstreamSemanticMs: optionalFinite(row.upstreamSemanticMs),
    retryOverheadMs: optionalFinite(row.retryOverheadMs),
    warmup: bool(row.warmup),
    cacheDowngrade: text(row.cacheDowngrade, '', 80),
    usageObserved: bool(row.usageObserved)
  }
}

export function toHudSnapshot(value: unknown): HudSnapshot {
  const snapshot = asRecord(value)
  const runtime = asRecord(snapshot.runtime)
  const sources = asRecord(runtime.sources)
  const codex = asRecord(sources.codex)
  const totals = asRecord(snapshot.totals)
  const cachePolicy = asRecord(snapshot.cachePolicy)
  return {
    version: finite(snapshot.version),
    generatedAt: finite(snapshot.generatedAt),
    runtime: {
      healthy: bool(runtime.healthy),
      mode: text(runtime.mode, 'unknown', 40),
      port: finite(runtime.port),
      connection: text(runtime.connection, 'offline', 40),
      componentWarnings: stringList(runtime.componentWarnings),
      codex: {
        toolSurface: text(codex.toolSurface, 'classic-forced', 80),
        toolSurfaceState: text(codex.toolSurfaceState, 'unknown', 32),
        diskToolMode: text(codex.diskToolMode, '—', 60),
        zeroToolRisk: bool(codex.zeroToolRisk)
      }
    },
    totals: {
      activeSessions: finite(totals.activeSessions),
      warnings: finite(totals.warnings),
      calls: finite(totals.calls),
      input: finite(totals.input),
      output: finite(totals.output),
      cached: finite(totals.cached),
      cacheWrite: finite(totals.cacheWrite),
      hitRate: finite(totals.hitRate),
      openCircuits: finite(totals.openCircuits)
    },
    cachePolicy: {
      activeWarmups: finite(cachePolicy.activeWarmups),
      warmupSent: finite(cachePolicy.warmupSent)
    },
    sessions: asArray(snapshot.sessions).map(sessionFrom),
    providers: asArray(snapshot.providers).map(providerFrom),
    tasks: asArray(snapshot.tasks).map(taskFrom),
    recentRequests: asArray(snapshot.recentRequests).map(requestFrom)
  }
}

export function hudToneForProvider(state: string): HudTone {
  if (state === 'alive') return 'live'
  if (state === 'degraded') return 'warning'
  if (state === 'circuit-open') return 'danger'
  return 'muted'
}

export function hudToneForSession(session: HudSession): HudTone {
  if (session.warning) return 'danger'
  if (session.active) return 'live'
  if (session.stale || session.lifecycle === 'recently-ended') return 'warning'
  return 'muted'
}
