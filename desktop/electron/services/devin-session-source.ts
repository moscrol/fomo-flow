import { createHash } from 'node:crypto'
import { readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

const MAX_DIRECTORY_ENTRIES = 512
const MAX_STATUS_FILES = 64
const MAX_STATUS_FILE_BYTES = 256 * 1024
const LIVE_SESSION_MS = 5 * 60_000
const TERMINAL_STATES = new Set(['stopped', 'closed', 'completed', 'cancelled'])

export type SafeDevinSession = Record<string, unknown> & {
  id: string
  surface: 'devin'
  latestActivityAt: number
  route: {
    modelUid: string
    provider: string
    upstreamModel: string
    provisional: boolean
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function finite(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0
}

function safeFact(value: unknown, limit: number): string {
  if (typeof value !== 'string') return ''
  const normalized = value.trim().replace(/\s+/g, ' ').slice(0, limit)
  if (!normalized) return ''
  if (/authorization\s*:|\bbearer\s+|\bsk-[a-z0-9_-]+/i.test(normalized)) return ''
  if (/^(?:file:\/\/|[a-z]:[\\/]|\/)/i.test(normalized)) return ''
  return normalized
}

function sessionId(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 12)
}

export function projectDevinSession(value: unknown, now = Date.now()): SafeDevinSession | null {
  const summary = record(value)
  const key = typeof summary.key === 'string' ? summary.key.trim() : ''
  if (!key) return null

  const activation = record(summary.activation)
  const activationState = safeFact(activation.state, 40).toLowerCase()
  if (activationState !== 'active' || TERMINAL_STATES.has(activationState)) return null

  const activity = record(summary.activity)
  const latestActivityAt = Math.max(
    finite(summary.updatedAt),
    finite(activity.lastRequestAt),
    finite(activity.lastUpdateAt)
  )
  if (!latestActivityAt || Math.max(0, now - latestActivityAt) > LIVE_SESSION_MS) return null

  const route = record(summary.route)
  const identity = record(summary.identity)
  const requestInFlight = activity.requestInFlight === true
  const freshnessMs = Math.max(0, now - latestActivityAt)
  return {
    id: sessionId(key),
    surface: 'devin',
    identityKind: identity.kind === 'native' ? 'native' : 'derived',
    mode: safeFact(summary.mode, 32) || 'auto',
    activation: 'active',
    active: true,
    lifecycle: 'active',
    stale: false,
    warning: false,
    updatedAt: finite(summary.updatedAt) || latestActivityAt,
    observedAt: now,
    latestActivityAt,
    freshnessMs,
    requestInFlight,
    goal: '',
    phase: safeFact(summary.phase, 80) || '运行中',
    workspace: '',
    todo: { completed: 0, total: 0, current: '' },
    verification: { status: 'unknown', blocking: false },
    failures: {
      maxConsecutive: 0,
      sameCallStreak: 0,
      lastToolOk: null,
      hasLastError: false
    },
    route: {
      modelUid: safeFact(route.modelUid, 120),
      provider: route.provisional === true ? '' : safeFact(route.provider, 120),
      upstreamModel: safeFact(route.upstreamModel, 120),
      provisional: route.provisional === true
    },
    telemetry: {
      reasoningTokens: 0,
      compactions: 0,
      ttftMs: null,
      durationMs: null,
      modelPath: 'routed',
      loopSource: 'agent-status'
    },
    cache: {
      observed: false,
      calls: 0,
      input: 0,
      cached: 0,
      cacheWrite: 0,
      hitRate: 0,
      latestAt: 0
    }
  }
}

export function createDevinSessionSource({
  statusDirectory,
  now = Date.now
}: {
  statusDirectory: string
  now?: () => number
}) {
  return {
    async sessions(): Promise<SafeDevinSession[]> {
      try {
        const entries = (await readdir(statusDirectory, { withFileTypes: true }))
          .filter(
            (entry) =>
              entry.isFile() &&
              entry.name.length <= 180 &&
              entry.name.endsWith('.json') &&
              !entry.name.includes('/') &&
              !entry.name.includes('\\')
          )
          .slice(0, MAX_DIRECTORY_ENTRIES)
        const ranked = await Promise.all(
          entries.map(async (entry) => ({
            name: entry.name,
            mtimeMs: (await stat(join(statusDirectory, entry.name))).mtimeMs
          }))
        )
        ranked.sort((left, right) => right.mtimeMs - left.mtimeMs)

        const projected = await Promise.all(
          ranked.slice(0, MAX_STATUS_FILES).map(async ({ name }) => {
            try {
              const body = await readFile(join(statusDirectory, name))
              if (body.byteLength > MAX_STATUS_FILE_BYTES) return null
              return projectDevinSession(JSON.parse(body.toString('utf8')), now())
            } catch {
              return null
            }
          })
        )
        const newestById = new Map<string, SafeDevinSession>()
        for (const session of projected) {
          if (!session) continue
          const current = newestById.get(session.id)
          if (!current || session.latestActivityAt > current.latestActivityAt) {
            newestById.set(session.id, session)
          }
        }
        return [...newestById.values()].sort(
          (left, right) => right.latestActivityAt - left.latestActivityAt
        )
      } catch {
        return []
      }
    }
  }
}
