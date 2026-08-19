export type DaoDesktopStatus = {
  healthy: boolean
  running: boolean
  port: number | null
  url: string | null
  profile: 'desktop'
  imported: { config: boolean; revproxy: boolean }
  error: string | null
}

export type DaoDashboardUsage = {
  calls: number
  input: number
  output: number
  total: number
}

export type DaoDashboardProvider = {
  name: string
  label: string
  type: string
  endpointHost: string | null
  enabled: boolean
  builtin: boolean
  modelCount: number
  models: string[]
  health: {
    alive: boolean | null
    status: number | null
    reason: string | null
  }
  usage: DaoDashboardUsage
}

export type DaoDashboardRoute = {
  uid: string
  provider: string | null
  model: string | null
  enabled: boolean
  fallbackCount: number
}

export type DaoDashboardFailureProvider = {
  name: string
  total: number
  topKind: string | null
  kinds: Array<{ kind: string; count: number }>
}

export type DaoDashboardSnapshot = {
  refreshedAt: number
  partial: boolean
  availableModelCount: number
  routerReady: boolean
  eaRunning: boolean
  familyTierExtend: boolean
  providers: DaoDashboardProvider[]
  routes: DaoDashboardRoute[]
  usage: DaoDashboardUsage
  revproxy: {
    enabled: boolean
    port: number | null
    modelCount: number
    hasKey: boolean
    applyInvert: boolean
    isolatePrompt: boolean
    exposeLan: boolean
    dualPath: boolean
    premiumQuota: string | null
  }
  failureProviders: DaoDashboardFailureProvider[]
}

export const emptyDaoDashboardSnapshot: DaoDashboardSnapshot = {
  refreshedAt: 0,
  partial: true,
  availableModelCount: 0,
  routerReady: false,
  eaRunning: false,
  familyTierExtend: false,
  providers: [],
  routes: [],
  usage: { calls: 0, input: 0, output: 0, total: 0 },
  revproxy: {
    enabled: false,
    port: null,
    modelCount: 0,
    hasKey: false,
    applyInvert: false,
    isolatePrompt: true,
    exposeLan: false,
    dualPath: true,
    premiumQuota: null
  },
  failureProviders: []
}

export function isDaoDesktopStatus(value: unknown): value is DaoDesktopStatus {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const status = value as Record<string, unknown>
  const imported = status.imported
  return (
    typeof status.healthy === 'boolean' &&
    typeof status.running === 'boolean' &&
    (typeof status.port === 'number' || status.port === null) &&
    (typeof status.url === 'string' || status.url === null) &&
    status.profile === 'desktop' &&
    !!imported &&
    typeof imported === 'object' &&
    !Array.isArray(imported) &&
    typeof (imported as Record<string, unknown>).config === 'boolean' &&
    typeof (imported as Record<string, unknown>).revproxy === 'boolean' &&
    (typeof status.error === 'string' || status.error === null)
  )
}

export function isDaoDashboardSnapshot(value: unknown): value is DaoDashboardSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const snapshot = value as Record<string, unknown>
  return (
    typeof snapshot.refreshedAt === 'number' &&
    typeof snapshot.partial === 'boolean' &&
    typeof snapshot.availableModelCount === 'number' &&
    typeof snapshot.routerReady === 'boolean' &&
    typeof snapshot.eaRunning === 'boolean' &&
    typeof snapshot.familyTierExtend === 'boolean' &&
    Array.isArray(snapshot.providers) &&
    Array.isArray(snapshot.routes) &&
    isUsage(snapshot.usage) &&
    isRevproxy(snapshot.revproxy) &&
    Array.isArray(snapshot.failureProviders)
  )
}

function isUsage(value: unknown): value is DaoDashboardUsage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const usage = value as Record<string, unknown>
  return ['calls', 'input', 'output', 'total'].every(
    (key) => typeof usage[key] === 'number' && Number.isFinite(usage[key])
  )
}

function isRevproxy(value: unknown): value is DaoDashboardSnapshot['revproxy'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const revproxy = value as Record<string, unknown>
  return (
    typeof revproxy.enabled === 'boolean' &&
    (typeof revproxy.port === 'number' || revproxy.port === null) &&
    typeof revproxy.modelCount === 'number' &&
    typeof revproxy.hasKey === 'boolean' &&
    typeof revproxy.applyInvert === 'boolean' &&
    typeof revproxy.isolatePrompt === 'boolean' &&
    typeof revproxy.exposeLan === 'boolean' &&
    typeof revproxy.dualPath === 'boolean' &&
    (typeof revproxy.premiumQuota === 'string' || revproxy.premiumQuota === null)
  )
}
