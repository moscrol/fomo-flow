export const DEVIN_HOST_PHASES = [
  'unavailable',
  'runtime_offline',
  'ready',
  'starting',
  'connected',
  'running',
  'waiting_permission',
  'stopping',
  'stopped',
  'failed'
] as const

export type DevinHostPhase = (typeof DEVIN_HOST_PHASES)[number]
export type DevinHostEventKind = 'message' | 'thought' | 'plan' | 'tool' | 'usage' | 'status'
export type DevinHostEventStatus = 'info' | 'running' | 'completed' | 'failed'
export type DevinHostErrorCode =
  | 'devin_missing'
  | 'proxy_missing'
  | 'runtime_offline'
  | 'protocol_error'
  | 'authentication_failed'
  | 'process_exited'
  | 'invalid_request'
  | 'unknown'

export type DevinHostModelOption = { value: string; label: string }
export type DevinHostEvent = {
  id: string
  kind: DevinHostEventKind
  message: string
  status: DevinHostEventStatus
  at: number
}
export type DevinHostPermission = {
  id: string
  category: '读取文件' | '修改文件' | '运行本地命令' | '使用工具'
  message: string
  allowOnce: boolean
}
export type DevinHostSnapshot = {
  phase: DevinHostPhase
  runtimeHealthy: boolean
  devinAvailable: boolean
  workspace?: { handle: string; label: string }
  models: DevinHostModelOption[]
  selectedModel: string
  events: DevinHostEvent[]
  permission?: DevinHostPermission
  droppedEventCount: number
  error?: { code: DevinHostErrorCode; message: string }
}

const PHASES = new Set<string>(DEVIN_HOST_PHASES)
const EVENT_KINDS = new Set<string>(['message', 'thought', 'plan', 'tool', 'usage', 'status'])
const EVENT_STATUSES = new Set<string>(['info', 'running', 'completed', 'failed'])
const ERROR_CODES = new Set<string>([
  'devin_missing',
  'proxy_missing',
  'runtime_offline',
  'protocol_error',
  'authentication_failed',
  'process_exited',
  'invalid_request',
  'unknown'
])
const TOOL_CATEGORIES = new Set<string>(['读取文件', '修改文件', '运行本地命令', '使用工具'])
const HANDLE = /^[a-f0-9]{32}$/
const MODEL_VALUE = /^[A-Za-z0-9._:-]{1,120}$/

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function exactKeys(value: Record<string, unknown>, required: string[], optional: string[] = []) {
  const allowed = new Set([...required, ...optional])
  return (
    required.every((key) => key in value) && Object.keys(value).every((key) => allowed.has(key))
  )
}

function shortText(value: unknown, limit: number): value is string {
  return typeof value === 'string' && value.length <= limit
}

export function isDevinHostSnapshot(value: unknown): value is DevinHostSnapshot {
  const root = record(value)
  if (
    !root ||
    !exactKeys(
      root,
      [
        'phase',
        'runtimeHealthy',
        'devinAvailable',
        'models',
        'selectedModel',
        'events',
        'droppedEventCount'
      ],
      ['workspace', 'permission', 'error']
    ) ||
    typeof root.phase !== 'string' ||
    !PHASES.has(root.phase) ||
    typeof root.runtimeHealthy !== 'boolean' ||
    typeof root.devinAvailable !== 'boolean' ||
    !shortText(root.selectedModel, 120) ||
    !Number.isSafeInteger(root.droppedEventCount) ||
    Number(root.droppedEventCount) < 0 ||
    !Array.isArray(root.models) ||
    root.models.length > 50 ||
    !Array.isArray(root.events) ||
    root.events.length > 200
  ) {
    return false
  }

  if (
    !root.models.every((item) => {
      const model = record(item)
      return (
        !!model &&
        exactKeys(model, ['value', 'label']) &&
        typeof model.value === 'string' &&
        MODEL_VALUE.test(model.value) &&
        shortText(model.label, 160)
      )
    }) ||
    !root.events.every((item) => {
      const event = record(item)
      return (
        !!event &&
        exactKeys(event, ['id', 'kind', 'message', 'status', 'at']) &&
        typeof event.id === 'string' &&
        HANDLE.test(event.id) &&
        typeof event.kind === 'string' &&
        EVENT_KINDS.has(event.kind) &&
        shortText(event.message, 2_000) &&
        typeof event.status === 'string' &&
        EVENT_STATUSES.has(event.status) &&
        typeof event.at === 'number' &&
        Number.isFinite(event.at)
      )
    })
  ) {
    return false
  }

  if (root.workspace !== undefined) {
    const workspace = record(root.workspace)
    if (
      !workspace ||
      !exactKeys(workspace, ['handle', 'label']) ||
      typeof workspace.handle !== 'string' ||
      !HANDLE.test(workspace.handle) ||
      !shortText(workspace.label, 120)
    ) {
      return false
    }
  }
  if (root.permission !== undefined) {
    const permission = record(root.permission)
    if (
      !permission ||
      !exactKeys(permission, ['id', 'category', 'message', 'allowOnce']) ||
      typeof permission.id !== 'string' ||
      !HANDLE.test(permission.id) ||
      typeof permission.category !== 'string' ||
      !TOOL_CATEGORIES.has(permission.category) ||
      !shortText(permission.message, 240) ||
      typeof permission.allowOnce !== 'boolean'
    ) {
      return false
    }
  }
  if (root.error !== undefined) {
    const error = record(root.error)
    if (
      !error ||
      !exactKeys(error, ['code', 'message']) ||
      typeof error.code !== 'string' ||
      !ERROR_CODES.has(error.code) ||
      !shortText(error.message, 240)
    ) {
      return false
    }
  }
  return true
}
