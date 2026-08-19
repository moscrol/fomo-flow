import {
  emptyDaoDashboardSnapshot,
  isDaoDashboardSnapshot,
  isDaoDesktopStatus,
  type DaoDashboardSnapshot,
  type DaoDesktopStatus
} from './types'
import type { ChannelMigrationApplyResult, ChannelMigrationPreview } from './channelMigration'
import type { DevinHostSnapshot } from './devinAcpHost'
export {
  DEVIN_HOST_PHASES,
  isDevinHostSnapshot,
  type DevinHostErrorCode,
  type DevinHostEvent,
  type DevinHostEventKind,
  type DevinHostEventStatus,
  type DevinHostModelOption,
  type DevinHostPermission,
  type DevinHostPhase,
  type DevinHostSnapshot
} from './devinAcpHost'

export type DaoControlMethod = 'GET' | 'POST' | 'DELETE'

export type DaoControlResponse = {
  ok: boolean
  status: number
  data: unknown
}

export type WorkResolution = 'acknowledged' | 'promoted'

export type TaskboardWorkItem = {
  identifier: string
  title: string
  status: 'blocked' | 'in_progress' | 'in_review'
  priority: 'none' | 'urgent' | 'high' | 'medium' | 'low'
  updatedAt: number
}

export type TaskboardSnapshot = {
  state: 'connected' | 'disconnected' | 'unmapped'
  writable: boolean
  message: string
  items: TaskboardWorkItem[]
}

export type PromoteWorkDraft = {
  fingerprint: string
  title: string
  sourceKind: 'session' | 'task'
  failureKind: 'failed' | 'timed_out' | 'detached' | 'transport_lost' | 'stale' | 'blocked'
  acceptance: string
}

export type CreatedTaskboardWork = {
  identifier: string
  title: string
  status: 'todo'
  priority: 'medium'
  updatedAt: number
}

export type DesktopHost = {
  getRuntimeStatus(): Promise<DaoDesktopStatus>
  retryRuntime(): Promise<DaoDesktopStatus>
  getDashboardSnapshot(): Promise<DaoDashboardSnapshot>
  openExternal(url: string): Promise<void>
  openConfig(): Promise<void>
  openControlConsole(): Promise<void>
  requestControl(
    path: string,
    method?: DaoControlMethod,
    body?: unknown
  ): Promise<DaoControlResponse>
  saveHandoff(content: string, filename?: string): Promise<{ ok: boolean; canceled?: boolean }>
  writeClipboard(text: string): Promise<void>
  getResolvedWork?(fingerprints: string[]): Promise<string[]>
  resolveWork?(
    fingerprint: string,
    resolution: WorkResolution,
    taskIdentifier?: string
  ): Promise<void>
  getTaskboardSnapshot?(): Promise<TaskboardSnapshot>
  connectTaskboard?(): Promise<TaskboardSnapshot>
  createTaskboardWork?(draft: PromoteWorkDraft): Promise<CreatedTaskboardWork>
  previewChannelMigration?(): Promise<ChannelMigrationPreview>
  applyChannelMigration?(confirmationToken: string): Promise<ChannelMigrationApplyResult>
  getDevinHostStatus?(): Promise<DevinHostSnapshot>
  chooseDevinWorkspace?(): Promise<{ handle: string; label: string } | null>
  openDevinNative?(workspaceHandle: string): Promise<{ ok: true }>
  startDevinHost?(workspaceHandle: string): Promise<DevinHostSnapshot>
  promptDevinHost?(prompt: string, model?: string): Promise<DevinHostSnapshot>
  respondDevinPermission?(
    permissionId: string,
    decision: 'allow_once' | 'reject'
  ): Promise<DevinHostSnapshot>
  cancelDevinHost?(): Promise<DevinHostSnapshot>
  stopDevinHost?(): Promise<DevinHostSnapshot>
  subscribeDevinHost?(listener: (snapshot: DevinHostSnapshot) => void): () => void
}

declare global {
  interface Window {
    desktopHost?: DesktopHost
  }
}

const unavailableStatus: DaoDesktopStatus = {
  healthy: false,
  running: false,
  port: null,
  url: null,
  profile: 'desktop',
  imported: { config: false, revproxy: false },
  error: '本地运行时不可用'
}

const unavailableHost: DesktopHost = {
  async getRuntimeStatus() {
    return unavailableStatus
  },
  async retryRuntime() {
    return unavailableStatus
  },
  async getDashboardSnapshot() {
    return { ...emptyDaoDashboardSnapshot }
  },
  openExternal: () => Promise.resolve(),
  openConfig: () => Promise.resolve(),
  openControlConsole: () => Promise.resolve(),
  requestControl: async () => ({ ok: false, status: 503, data: { error: '本地运行时不可用' } }),
  saveHandoff: async () => ({ ok: false, canceled: true }),
  writeClipboard: () => Promise.resolve(),
  getResolvedWork: async () => [],
  resolveWork: () => Promise.resolve(),
  getTaskboardSnapshot: async () => ({
    state: 'disconnected',
    writable: false,
    message: '本地 Taskboard 暂时不可用，实时工作不受影响。',
    items: []
  }),
  connectTaskboard: async () => ({
    state: 'disconnected',
    writable: false,
    message: '本地 Taskboard 暂时不可用，实时工作不受影响。',
    items: []
  }),
  createTaskboardWork: async () => {
    throw new Error('本地 Taskboard 暂时不可写')
  },
  previewChannelMigration: async () => ({
    available: false,
    sourceLabel: '现有 FOMO FLOW 配置',
    providerNames: [],
    providerCount: 0,
    customModelCount: 0,
    routeCount: 0,
    newProviderCount: 0,
    overwrittenProviderCount: 0,
    preservedDesktopProviderCount: 0,
    priorityPreserved: true,
    message: '现有 FOMO FLOW 配置暂时不可迁移。'
  }),
  applyChannelMigration: async () => {
    throw new Error('现有 FOMO FLOW 配置暂时不可迁移')
  },
  getDevinHostStatus: async () => ({
    phase: 'unavailable',
    runtimeHealthy: false,
    devinAvailable: false,
    models: [],
    selectedModel: '',
    events: [],
    droppedEventCount: 0,
    error: { code: 'unknown', message: 'Devin 接入只在 FOMO FLOW App 中可用。' }
  }),
  chooseDevinWorkspace: async () => null,
  openDevinNative: async () => {
    throw new Error('Devin 原生入口只在 FOMO FLOW App 中可用')
  },
  startDevinHost: async () => {
    throw new Error('Devin 接入只在 FOMO FLOW App 中可用')
  },
  promptDevinHost: async () => {
    throw new Error('Devin 接入只在 FOMO FLOW App 中可用')
  },
  respondDevinPermission: async () => {
    throw new Error('Devin 接入只在 FOMO FLOW App 中可用')
  },
  cancelDevinHost: async () => {
    throw new Error('Devin 接入只在 FOMO FLOW App 中可用')
  },
  stopDevinHost: async () => ({
    phase: 'stopped',
    runtimeHealthy: false,
    devinAvailable: false,
    models: [],
    selectedModel: '',
    events: [],
    droppedEventCount: 0
  }),
  subscribeDevinHost: () => () => undefined
}

export function desktopHost(): DesktopHost {
  if (typeof window === 'undefined' || !window.desktopHost) return unavailableHost
  const host = window.desktopHost
  return {
    ...host,
    async getRuntimeStatus() {
      const status = await host.getRuntimeStatus()
      return isDaoDesktopStatus(status) ? status : unavailableStatus
    },
    async retryRuntime() {
      const status = await host.retryRuntime()
      return isDaoDesktopStatus(status) ? status : unavailableStatus
    },
    async getDashboardSnapshot() {
      const snapshot = await host.getDashboardSnapshot()
      return isDaoDashboardSnapshot(snapshot) ? snapshot : { ...emptyDaoDashboardSnapshot }
    }
  }
}

export {
  emptyDaoDashboardSnapshot,
  isDaoDashboardSnapshot,
  isDaoDesktopStatus,
  type DaoDashboardFailureProvider,
  type DaoDashboardProvider,
  type DaoDashboardRoute,
  type DaoDashboardSnapshot,
  type DaoDashboardUsage,
  type DaoDesktopStatus
} from './types'

export type {
  ChannelMigrationApplyResult,
  ChannelMigrationCounts,
  ChannelMigrationPreview
} from './channelMigration'
