export type DaoControlMethod = 'GET' | 'POST' | 'DELETE'

export type DaoControlRequestPayload = {
  path: string
  method: DaoControlMethod
  body?: unknown
}

export type DaoControlResponse = {
  ok: boolean
  status: number
  data: unknown
}

const MAX_PATH_LENGTH = 1_024
const MAX_BODY_LENGTH = 8 * 1024 * 1024

const READ_PREFIXES = [
  '/origin/hud/snapshot',
  '/origin/tasks',
  '/origin/ea/overview',
  '/origin/ea/status',
  '/origin/ea/usage',
  '/origin/ea/traces',
  '/origin/ea/alerts',
  '/origin/ea/failure-stats',
  '/origin/ea/audit',
  '/origin/ea/config-backups',
  '/origin/ea/config-pack',
  '/origin/ea/providers',
  '/origin/ea/routes',
  '/origin/ea/custom-models',
  '/origin/ea/model-capability',
  '/origin/ea/models/',
  '/origin/ea/handoff.md',
  '/origin/revproxy/status',
  '/origin/revproxy/models',
  '/origin/revproxy/tier',
  '/origin/revproxy/tunnel',
  '/origin/revproxy/handoff.md',
  '/origin/protocol-bridges',
  '/origin/preview',
  '/origin/custom_sp',
  '/origin/mode',
  '/origin/canon',
  '/origin/codex-hot-route'
] as const

const EXACT_READ_PATHS = [
  '/origin/ea/routing-decisions',
  '/origin/ea/decision-inbox',
  '/origin/ea/route-evidence'
] as const

const PREFLIGHT_PATH = '/origin/ea/route-preflight'
const DECISION_ACTION_PATH = /^\/origin\/ea\/decision-inbox\/decision-[a-f0-9]{24}\/(ack|snooze)$/
const MAX_PREFLIGHT_BODY_LENGTH = 16 * 1024
const MAX_DECISION_ACTION_BODY_LENGTH = 1024
const OBSERVATION_READ_PATHS = new Set([
  '/origin/hud/snapshot',
  '/origin/tasks',
  '/origin/ea/usage',
  '/origin/ea/alerts',
  '/origin/ea/failure-stats',
  '/origin/ea/traces'
])

const LIMITED_OBSERVATION_PATHS = new Set(['/origin/ea/alerts', '/origin/ea/traces'])

export function normalizeDaoObservationPath(path: string): string | null {
  try {
    const parsed = new URL(path, 'http://127.0.0.1')
    if (parsed.origin !== 'http://127.0.0.1' || !OBSERVATION_READ_PATHS.has(parsed.pathname)) {
      return null
    }
    if (!parsed.search) return parsed.pathname
    if (!LIMITED_OBSERVATION_PATHS.has(parsed.pathname)) return null
    const entries = [...parsed.searchParams.entries()]
    if (entries.length !== 1 || entries[0][0] !== 'limit' || !/^\d{1,3}$/.test(entries[0][1])) {
      return null
    }
    const limit = Number(entries[0][1])
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) return null
    return `${parsed.pathname}?limit=${limit}`
  } catch {
    return null
  }
}

export function isDaoObservationRequest(payload: DaoControlRequestPayload): boolean {
  return payload.method === 'GET' && normalizeDaoObservationPath(payload.path) !== null
}

const WRITE_PREFIXES = [
  '/origin/ea/provider',
  '/origin/ea/route',
  '/origin/ea/reasoning',
  '/origin/ea/config',
  '/origin/ea/reload',
  '/origin/ea/probe',
  '/origin/ea/reset-health',
  '/origin/ea/custom-model',
  '/origin/ea/config-rollback',
  '/origin/ea/config-pack',
  '/origin/revproxy/config',
  '/origin/revproxy/models',
  '/origin/revproxy/tier',
  '/origin/revproxy/tunnel',
  '/origin/protocol-bridges',
  '/origin/mode',
  '/origin/canon',
  '/origin/custom_sp',
  '/origin/codex-hot-route'
] as const

export function requiresDaoTaskAuthorization(path: string): boolean {
  try {
    const parsed = new URL(path, 'http://127.0.0.1')
    return (
      parsed.origin === 'http://127.0.0.1' &&
      (parsed.pathname === '/origin/tasks' || parsed.pathname.startsWith('/origin/tasks/'))
    )
  } catch {
    return false
  }
}

function hasPrefix(pathname: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => pathname === prefix || pathname.startsWith(prefix + '/'))
}

function isDecisionActionBody(pathname: string, body: unknown): boolean {
  const match = pathname.match(DECISION_ACTION_PATH)
  if (!match || !body || typeof body !== 'object' || Array.isArray(body)) return false
  const record = body as Record<string, unknown>
  if (match[1] === 'ack') return Object.keys(record).length === 0
  return (
    Object.keys(record).length === 1 &&
    typeof record.minutes === 'number' &&
    Number.isFinite(record.minutes) &&
    record.minutes >= 1 &&
    record.minutes <= 7 * 24 * 60
  )
}

export function isAllowedDaoControlRequest(payload: unknown): payload is DaoControlRequestPayload {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false
  const record = payload as Record<string, unknown>
  if (
    typeof record.path !== 'string' ||
    record.path.length === 0 ||
    record.path.length > MAX_PATH_LENGTH
  ) {
    return false
  }
  if (record.method !== 'GET' && record.method !== 'POST' && record.method !== 'DELETE')
    return false
  if (Object.keys(record).some((key) => key !== 'path' && key !== 'method' && key !== 'body')) {
    return false
  }
  let parsed: URL
  try {
    parsed = new URL(record.path, 'http://127.0.0.1')
  } catch {
    return false
  }
  if (parsed.origin !== 'http://127.0.0.1' || !parsed.pathname.startsWith('/origin/')) return false
  if (
    record.method === 'GET' &&
    OBSERVATION_READ_PATHS.has(parsed.pathname) &&
    normalizeDaoObservationPath(record.path) === null
  ) {
    return false
  }
  const decisionAction = DECISION_ACTION_PATH.test(parsed.pathname)
  const allowed =
    record.method === 'GET'
      ? EXACT_READ_PATHS.includes(parsed.pathname as (typeof EXACT_READ_PATHS)[number]) ||
        hasPrefix(parsed.pathname, READ_PREFIXES)
      : record.method === 'POST' &&
        (parsed.pathname === PREFLIGHT_PATH ||
          decisionAction ||
          hasPrefix(parsed.pathname, WRITE_PREFIXES))
  if (!allowed) return false
  if (record.method === 'GET' && record.body !== undefined) return false
  if (record.body !== undefined) {
    try {
      const serialized = JSON.stringify(record.body)
      if (serialized.length > MAX_BODY_LENGTH) return false
      if (parsed.pathname === PREFLIGHT_PATH) {
        if (!record.body || typeof record.body !== 'object' || Array.isArray(record.body))
          return false
        if (Buffer.byteLength(serialized, 'utf8') > MAX_PREFLIGHT_BODY_LENGTH) return false
      }
      if (decisionAction) {
        if (Buffer.byteLength(serialized, 'utf8') > MAX_DECISION_ACTION_BODY_LENGTH) return false
        if (!isDecisionActionBody(parsed.pathname, record.body)) return false
      }
    } catch {
      return false
    }
  }
  return true
}

export function controlRequestUrl(baseUrl: string, path: string): string | null {
  try {
    const base = new URL(baseUrl)
    const target = new URL(path, base)
    if (base.protocol !== 'http:' || base.hostname !== '127.0.0.1') return null
    if (target.origin !== base.origin || !target.pathname.startsWith('/origin/')) return null
    return target.toString()
  } catch {
    return null
  }
}

export async function readDaoLocalApiKey(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch
): Promise<string | null> {
  const statusUrl = controlRequestUrl(baseUrl, '/origin/revproxy/status')
  if (!statusUrl) return null
  try {
    const response = await fetchImpl(statusUrl, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(3_500)
    })
    if (!response.ok) return null
    const payload: unknown = await response.json()
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null
    const key = (payload as { apiKey?: unknown }).apiKey
    return typeof key === 'string' && key.length > 0 && key.length <= 512 ? key : null
  } catch {
    return null
  }
}

export async function readDaoControlResponse(response: Response): Promise<DaoControlResponse> {
  const text = await response.text()
  if (text.length > MAX_BODY_LENGTH) throw new Error('Dao control response is too large')
  let data: unknown = text
  try {
    data = text ? JSON.parse(text) : {}
  } catch {
    // Markdown handoffs and other text endpoints intentionally remain strings.
  }
  return { ok: response.ok, status: response.status, data }
}
