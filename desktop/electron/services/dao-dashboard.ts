import type { DaoDesktopStatus } from '../../src/lib/desktopHost/types'
import {
  emptyDaoDashboardSnapshot,
  type DaoDashboardFailureProvider,
  type DaoDashboardProvider,
  type DaoDashboardRoute,
  type DaoDashboardSnapshot,
  type DaoDashboardUsage
} from '../../src/lib/desktopHost/types'

type JsonRecord = Record<string, unknown>
type JsonReader = (path: string) => Promise<unknown>

const MAX_ITEMS = 200
const MAX_TEXT = 160

function record(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : {}
}

function text(value: unknown, fallback = '', limit = MAX_TEXT): string {
  if (typeof value !== 'string' && typeof value !== 'number') return fallback
  return (
    String(value)
      .replace(/\p{Cc}/gu, ' ')
      .trim()
      .slice(0, limit) || fallback
  )
}

function count(value: unknown, max = 1_000_000_000_000): number {
  const number = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(number) && number >= 0 ? Math.min(Math.floor(number), max) : 0
}

function usage(value: unknown): DaoDashboardUsage {
  const source = record(value)
  const input = count(source.input)
  const output = count(source.output)
  return {
    calls: count(source.calls),
    input,
    output,
    total: count(source.total, 2_000_000_000_000) || Math.min(input + output, 2_000_000_000_000)
  }
}

function safeHost(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2_000) return null
  try {
    const parsed = new URL(value)
    if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname) return null
    return parsed.hostname + (parsed.port ? `:${parsed.port}` : '')
  } catch {
    return null
  }
}

function safeModels(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((item) => typeof item === 'string' || typeof item === 'number')
    .map((item) => text(item))
    .filter(Boolean)
    .slice(0, 100)
}

function provider(name: string, value: unknown): DaoDashboardProvider {
  const source = record(value)
  const models = safeModels(source.models)
  const healthSource = record(source.health)
  const healthAlive = typeof healthSource.alive === 'boolean' ? healthSource.alive : null
  const healthStatus =
    typeof healthSource.status === 'number' && Number.isFinite(healthSource.status)
      ? Math.max(0, Math.min(599, Math.floor(healthSource.status)))
      : null
  return {
    name: text(name, 'unknown', 100),
    label: text(source._label || source.label || name, name, 100),
    type: text(source.type || source.driver, 'unknown', 80),
    endpointHost: safeHost(source.baseUrl || source.baseURL || source.endpoint),
    enabled: source.enabled !== false,
    builtin: source._builtin === true,
    modelCount: models.length || count(source.modelCount, 10_000),
    models,
    health: {
      alive: healthAlive,
      status: healthStatus,
      reason: text(healthSource.reason, '', 180) || null
    },
    usage: usage(source.usage)
  }
}

function route(uid: string, value: unknown): DaoDashboardRoute {
  const source = record(value)
  const priority = Array.isArray(source.channelPriority) ? source.channelPriority : []
  return {
    uid: text(uid, 'unknown', 180),
    provider: typeof source.provider === 'string' ? text(source.provider, '', 100) || null : null,
    model:
      typeof source.model === 'string'
        ? text(source.model, '', 180) || null
        : typeof source.targetModel === 'string'
          ? text(source.targetModel, '', 180) || null
          : null,
    enabled: source.enabled !== false,
    fallbackCount: Math.min(priority.length, 50)
  }
}

function failureProviders(value: unknown): DaoDashboardFailureProvider[] {
  const source = record(value)
  return Object.entries(source)
    .slice(0, MAX_ITEMS)
    .map(([name, raw]) => {
      const item = record(raw)
      const kinds = record(item.kinds)
      return {
        name: text(name, 'unknown', 100),
        total: count(item.total),
        topKind: text(item.topKind, '', 80) || null,
        kinds: Object.entries(kinds)
          .slice(0, 30)
          .map(([kind, detail]) => ({
            kind: text(kind, 'other', 80),
            count: count(record(detail).count)
          }))
      }
    })
    .filter((item) => item.total > 0 || item.kinds.length > 0)
}

function listFromRecord<T>(value: unknown, convert: (key: string, value: unknown) => T): T[] {
  return Object.entries(record(value))
    .slice(0, MAX_ITEMS)
    .map(([key, item]) => convert(key, item))
}

function mergeUsage(overview: JsonRecord, usagePayload: JsonRecord): DaoDashboardUsage {
  const totals = record(usagePayload.totals)
  return usage(
    totals.calls == null && totals.input == null && totals.output == null ? overview.usage : totals
  )
}

export type DaoDashboardService = {
  snapshot(): Promise<DaoDashboardSnapshot>
}

export function createDaoDashboardService({
  getStatus,
  readJson,
  readObservationJson = readJson,
  now = () => Date.now()
}: {
  getStatus(): DaoDesktopStatus
  readJson(path: string): Promise<unknown>
  readObservationJson?: JsonReader
  now?: () => number
}): DaoDashboardService {
  return {
    async snapshot() {
      const status = getStatus()
      if (!status.healthy || !status.url) {
        return { ...emptyDaoDashboardSnapshot, refreshedAt: now() }
      }

      const results = await Promise.all([
        readJson('/origin/ea/overview').catch(() => null),
        readObservationJson('/origin/ea/usage').catch(() => null),
        readObservationJson('/origin/ea/failure-stats').catch(() => null),
        readJson('/origin/revproxy/status').catch(() => null)
      ])
      const [overviewValue, usageValue, failuresValue, revproxyValue] = results
      const overview = record(overviewValue)
      const usagePayload = record(usageValue)
      const revproxy = record(revproxyValue)
      const providers = listFromRecord(overview.providers, provider)
      const routes = listFromRecord(overview.routes, route)
      const revproxyFallback = emptyDaoDashboardSnapshot.revproxy
      const snapshot: DaoDashboardSnapshot = {
        refreshedAt: now(),
        partial: results.some((result) => result === null),
        availableModelCount: Array.isArray(overview.available_models)
          ? Math.min(overview.available_models.length, 10_000)
          : 0,
        routerReady: overview.router_ready === true,
        eaRunning: overview.ea_running === true,
        familyTierExtend: overview.family_tier_extend === true,
        providers,
        routes,
        usage: mergeUsage(overview, usagePayload),
        revproxy: {
          enabled: revproxy.enabled === true,
          port:
            Number.isInteger(revproxy.port) && Number(revproxy.port) > 0
              ? Number(revproxy.port)
              : null,
          modelCount: count(revproxy.model_count, 10_000),
          hasKey: revproxy.hasKey === true,
          applyInvert: revproxy.applyInvert === true,
          isolatePrompt: revproxy.isolatePrompt !== false,
          exposeLan: revproxy.exposeLan === true,
          dualPath: revproxy.dualPath !== false,
          premiumQuota: text(revproxy.premiumQuota, '', 40) || revproxyFallback.premiumQuota
        },
        failureProviders: failureProviders(record(failuresValue).stats)
      }
      return snapshot
    }
  }
}

export function createLoopbackJsonReader(getStatus: () => DaoDesktopStatus): JsonReader {
  return async (path) => {
    const status = getStatus()
    if (!status.healthy || !status.url) throw new Error('Dao runtime is not ready')
    const base = new URL(status.url)
    if (base.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)) {
      throw new Error('Dao runtime URL is not loopback')
    }
    const target = new URL(path, base)
    if (target.origin !== base.origin || !target.pathname.startsWith('/origin/')) {
      throw new Error('Dao dashboard path is not permitted')
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 3_500)
    try {
      const response = await fetch(target, {
        headers: { accept: 'application/json' },
        signal: controller.signal
      })
      if (!response.ok) throw new Error(`Dao dashboard request failed (${response.status})`)
      return await response.json()
    } finally {
      clearTimeout(timer)
    }
  }
}
