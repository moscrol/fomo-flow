import { readFile as readFileDefault } from 'node:fs/promises'

import { normalizeDaoObservationPath } from './dao-control'

const MAX_RESPONSE_BYTES = 8 * 1024 * 1024
const SESSION_ATTENTION_MS = 5 * 60_000
const SESSION_RETIRE_MS = 15 * 60_000

type ObservationSnapshot = Record<string, unknown>

type ObservationSource = {
  snapshot(): Promise<ObservationSnapshot>
  request(path: string): Promise<unknown>
}

type ObservationCandidate = { base: string; snapshot: ObservationSnapshot }

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function finite(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0
}

export function normalizeObservationBase(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null
  try {
    const parsed = new URL(value)
    const port = Number(parsed.port)
    if (
      parsed.protocol !== 'http:' ||
      parsed.hostname !== '127.0.0.1' ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash ||
      (parsed.pathname !== '/' && parsed.pathname !== '') ||
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65535
    ) {
      return null
    }
    return `http://127.0.0.1:${port}`
  } catch {
    return null
  }
}

export function parseObservationDescriptor(value: unknown): string | null {
  let descriptor: unknown = value
  if (typeof descriptor === 'string') {
    try {
      descriptor = JSON.parse(descriptor)
    } catch {
      return null
    }
  }
  const item = record(descriptor)
  const base = normalizeObservationBase(item.base)
  if (!base || item.host !== '127.0.0.1') return null
  if (Number(item.port) !== Number(new URL(base).port)) return null
  return base
}

async function jsonResponse(response: Response): Promise<unknown> {
  if (!response.ok) throw new Error('Dao observation source is unavailable')
  const declaredLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    throw new Error('Dao observation response is too large')
  }
  if (!response.body) {
    const body = await response.text()
    if (new TextEncoder().encode(body).byteLength > MAX_RESPONSE_BYTES) {
      throw new Error('Dao observation response is too large')
    }
    return JSON.parse(body)
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let bytes = 0
  let body = ''
  while (true) {
    const chunk = await reader.read()
    if (chunk.done) break
    bytes += chunk.value.byteLength
    if (bytes > MAX_RESPONSE_BYTES) {
      await reader.cancel()
      throw new Error('Dao observation response is too large')
    }
    body += decoder.decode(chunk.value, { stream: true })
  }
  body += decoder.decode()
  return JSON.parse(body)
}

function evidence(snapshot: ObservationSnapshot): number[] {
  const sessions = Array.isArray(snapshot.sessions) ? snapshot.sessions.map(record) : []
  const requests = Array.isArray(snapshot.recentRequests) ? snapshot.recentRequests.map(record) : []
  const latestRequest = requests.reduce((latest, item) => Math.max(latest, finite(item.at)), 0)
  const latestSession = sessions.reduce(
    (latest, item) => Math.max(latest, finite(item.latestActivityAt)),
    0
  )
  const active = sessions.filter((item) => item.active === true)
  return [
    Math.max(latestRequest, latestSession),
    finite(snapshot.generatedAt),
    active.filter((item) => item.surface === 'devin').length,
    active.length,
    requests.length
  ]
}

function compareEvidence(left: ObservationSnapshot, right: ObservationSnapshot): number {
  const leftEvidence = evidence(left)
  const rightEvidence = evidence(right)
  for (let index = 0; index < leftEvidence.length; index += 1) {
    if (leftEvidence[index] !== rightEvidence[index]) {
      return rightEvidence[index] - leftEvidence[index]
    }
  }
  return 0
}

function safeSessionGoal(value: unknown): string {
  if (typeof value !== 'string') return ''
  const goal = value
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120)
  if (!goal || goal.startsWith('<')) return ''
  if (/^No MEMORIES were retrieved\b/i.test(goal)) return ''
  if (/^These memories were automatically retrieved\b/i.test(goal)) return ''
  if (/^The following memories (?:were|have been) automatically retrieved\b/i.test(goal)) return ''
  if (/^The following information is automatically generated\b/i.test(goal)) return ''
  if (/^You have \d+ weighted tokens left\b/i.test(goal)) return ''
  if (/^You are continuing work from a previous conversation thread\b/i.test(goal)) return ''
  if (/^Below is a summary of the previous conversation thread\b/i.test(goal)) return ''
  return goal
}

function enforceSessionLifecycle(snapshot: ObservationSnapshot): ObservationSnapshot {
  const generatedAt = finite(snapshot.generatedAt) || Date.now()
  const sourceSessions = Array.isArray(snapshot.sessions) ? snapshot.sessions.map(record) : []
  const sessions: Record<string, unknown>[] = []
  for (const session of sourceSessions) {
    const latestActivityAt = finite(session.latestActivityAt)
    const providedFreshness = Number(session.freshnessMs)
    if (!latestActivityAt && (!Number.isFinite(providedFreshness) || providedFreshness < 0))
      continue
    const freshnessMs = latestActivityAt
      ? Math.max(0, generatedAt - latestActivityAt)
      : providedFreshness
    if (freshnessMs > SESSION_RETIRE_MS) continue
    const activation = String(session.activation || '').toLowerCase()
    const terminal = ['stopped', 'closed', 'completed', 'cancelled'].includes(activation)
    sessions.push(
      terminal
        ? {
            ...session,
            goal: safeSessionGoal(session.goal),
            active: false,
            lifecycle: activation,
            stale: false,
            requestInFlight: false,
            freshnessMs
          }
        : freshnessMs > SESSION_ATTENTION_MS
          ? {
              ...session,
              goal: safeSessionGoal(session.goal),
              active: false,
              lifecycle: 'stale',
              stale: true,
              warning: true,
              requestInFlight: false,
              freshnessMs
            }
          : activation === 'active'
            ? {
                ...session,
                goal: safeSessionGoal(session.goal),
                active: true,
                lifecycle: 'active',
                stale: false,
                freshnessMs
              }
            : {
                ...session,
                goal: safeSessionGoal(session.goal),
                active: false,
                lifecycle: 'recently-ended',
                stale: false,
                freshnessMs
              }
    )
  }
  const totals = record(snapshot.totals)
  const rawSessionWarnings = sourceSessions.filter((session) => session.warning === true).length
  const nonSessionWarnings = Math.max(0, finite(totals.warnings) - rawSessionWarnings)
  return {
    ...snapshot,
    sessions,
    totals: {
      ...totals,
      activeSessions: sessions.filter((session) => session.active === true).length,
      warnings: nonSessionWarnings + sessions.filter((session) => session.warning === true).length
    }
  }
}

function mergeDevinSessions(
  snapshot: ObservationSnapshot,
  supplemental: Record<string, unknown>[]
): ObservationSnapshot {
  if (!supplemental.length) return snapshot
  const sessions = Array.isArray(snapshot.sessions) ? snapshot.sessions.map(record) : []
  const byId = new Map<string, Record<string, unknown>>()
  for (const session of sessions) {
    const id = typeof session.id === 'string' ? session.id : ''
    if (id) byId.set(id, session)
  }
  for (const fact of supplemental) {
    const id = typeof fact.id === 'string' ? fact.id : ''
    if (!id) continue
    const existing = byId.get(id)
    if (!existing) {
      sessions.push(fact)
      byId.set(id, fact)
      continue
    }
    if (finite(fact.latestActivityAt) < finite(existing.latestActivityAt)) continue
    const merged = {
      ...fact,
      ...existing,
      id,
      surface: 'devin',
      activation: fact.activation,
      active: fact.active,
      lifecycle: fact.lifecycle,
      stale: fact.stale,
      requestInFlight: fact.requestInFlight,
      updatedAt: fact.updatedAt,
      observedAt: fact.observedAt,
      latestActivityAt: fact.latestActivityAt,
      freshnessMs: fact.freshnessMs,
      phase: fact.phase || existing.phase,
      route: record(fact.route)
    }
    const index = sessions.indexOf(existing)
    if (index >= 0) sessions[index] = merged
    byId.set(id, merged)
  }
  const latestSupplemental = supplemental.reduce(
    (latest, session) =>
      Math.max(latest, finite(session.observedAt), finite(session.latestActivityAt)),
    0
  )
  return enforceSessionLifecycle({
    ...snapshot,
    generatedAt: Math.max(finite(snapshot.generatedAt), latestSupplemental),
    sessions
  })
}

export function createDaoObservationSource({
  getDesktopUrl,
  descriptorPaths,
  readFile = readFileDefault,
  fetchImpl = fetch,
  getLocalApiKey = async () => null,
  getDevinSessions = async () => []
}: {
  getDesktopUrl(): string | null
  descriptorPaths: string[]
  readFile?: (filePath: string, encoding: BufferEncoding) => Promise<string>
  fetchImpl?: typeof fetch
  getLocalApiKey?: (base: string) => Promise<string | null>
  getDevinSessions?: () => Promise<Record<string, unknown>[]>
}): ObservationSource {
  async function bases(): Promise<string[]> {
    const values: string[] = []
    const add = (value: unknown) => {
      const normalized = normalizeObservationBase(value)
      if (normalized && !values.includes(normalized)) values.push(normalized)
    }
    add(getDesktopUrl())
    for (const descriptorPath of descriptorPaths) {
      try {
        add(parseObservationDescriptor(await readFile(descriptorPath, 'utf8')))
      } catch {
        // A missing optional local runtime is an expected transition state.
      }
    }
    return values
  }

  async function candidate(base: string): Promise<ObservationCandidate | null> {
    try {
      const port = Number(new URL(base).port)
      const health = record(
        await jsonResponse(
          await fetchImpl(`${base}/origin/health`, {
            headers: { accept: 'application/json' },
            signal: AbortSignal.timeout(750)
          })
        )
      )
      if (health.ok !== true || health.dao_loaded !== true || Number(health.port) !== port) {
        return null
      }
      const rawSnapshot = record(
        await jsonResponse(
          await fetchImpl(`${base}/origin/hud/snapshot`, {
            headers: { accept: 'application/json' },
            signal: AbortSignal.timeout(1_500)
          })
        )
      )
      if (rawSnapshot.version !== 1) return null
      return { base, snapshot: enforceSessionLifecycle(rawSnapshot) }
    } catch {
      return null
    }
  }

  async function selected(): Promise<ObservationCandidate> {
    const candidates: ObservationCandidate[] = []
    for (const base of await bases()) {
      const value = await candidate(base)
      if (value) candidates.push(value)
    }
    if (!candidates.length) throw new Error('没有可用的本地 Dao 观测源')
    candidates.sort((left, right) => compareEvidence(left.snapshot, right.snapshot))
    const selectedCandidate = candidates[0]
    try {
      return {
        ...selectedCandidate,
        snapshot: mergeDevinSessions(selectedCandidate.snapshot, await getDevinSessions())
      }
    } catch {
      return selectedCandidate
    }
  }

  function observationPath(path: string): string | null {
    return normalizeDaoObservationPath(path)
  }

  return {
    async snapshot() {
      return (await selected()).snapshot
    },
    async request(path: string) {
      const safePath = observationPath(path)
      if (!safePath) throw new Error('Dao observation path is not permitted')
      const source = await selected()
      if (safePath === '/origin/hud/snapshot') return source.snapshot
      const headers: Record<string, string> = { accept: 'application/json' }
      if (safePath === '/origin/tasks') {
        const localApiKey = await getLocalApiKey(source.base)
        if (localApiKey) headers.Authorization = `Bearer ${localApiKey}`
      }
      return jsonResponse(
        await fetchImpl(`${source.base}${safePath}`, {
          headers,
          signal: AbortSignal.timeout(1_500)
        })
      )
    }
  }
}
