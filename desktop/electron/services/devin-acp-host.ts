import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { basename } from 'node:path'

import type {
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification
} from '@agentclientprotocol/sdk'
import { sanitizeDisplayText } from '../../src/components/work/displaySanitizer'
import type { DevinHostErrorCode, DevinHostSnapshot } from '../../src/lib/desktopHost/devinAcpHost'
import { createDevinAcpAdapter, type DevinAcpAdapter } from './devin-acp-adapter'
import {
  appendBoundedHostEvent,
  projectAcpUpdate,
  projectModelOptions,
  projectPermission
} from './devin-acp-projection'
import type { DevinAcpResources } from './devin-acp-resources'
import { launchNativeDevin } from './devin-native-launch'

export type HostChildProcess = ChildProcessWithoutNullStreams

type RuntimeStatus = { healthy: boolean; url: string | null }
type AdapterInput = {
  child: HostChildProcess
  onPermission(request: RequestPermissionRequest): Promise<RequestPermissionResponse>
  onUpdate(update: SessionNotification): void | Promise<void>
}

export type DevinAcpHostInput = {
  chooseDirectory(): Promise<string | null>
  createAdapter?: (input: AdapterInput) => DevinAcpAdapter
  id?: () => string
  now?: () => number
  openNative?: (workspacePath: string) => Promise<void>
  resolveResources(): DevinAcpResources
  runtimeStatus(): RuntimeStatus
  spawnProcess?: (
    resources: Extract<DevinAcpResources, { available: true }>,
    runtime: RuntimeStatus
  ) => HostChildProcess
}

export type DevinAcpHost = {
  status(): DevinHostSnapshot
  chooseWorkspace(): Promise<{ handle: string; label: string } | null>
  openNative(input: { workspaceHandle: string }): Promise<{ ok: true }>
  start(input: { workspaceHandle: string }): Promise<DevinHostSnapshot>
  prompt(input: { prompt: string; model?: string }): Promise<DevinHostSnapshot>
  respondPermission(input: {
    permissionId: string
    decision: 'allow_once' | 'reject'
  }): Promise<DevinHostSnapshot>
  cancel(): Promise<DevinHostSnapshot>
  stop(): Promise<DevinHostSnapshot>
  subscribe(listener: (snapshot: DevinHostSnapshot) => void): () => void
  observationSession(): Record<string, unknown> | null
}

type PendingPermission = {
  id: string
  allowOnceOption: string
  rejectOption: string
  resolve(response: RequestPermissionResponse): void
}

function newId(): string {
  return randomBytes(16).toString('hex')
}

function cloneSnapshot(snapshot: DevinHostSnapshot): DevinHostSnapshot {
  return structuredClone(snapshot)
}

function fixedError(code: DevinHostErrorCode): string {
  return {
    devin_missing: '未找到受支持的 Devin App，请安装或更新 Devin。',
    proxy_missing: 'FOMO ACP 接入资源不完整，请重新安装 FOMO FLOW。',
    runtime_offline: 'Dao Runtime 尚未就绪，请先重试本地运行时。',
    protocol_error: 'Devin ACP 通信失败，可以停止后重新连接。',
    authentication_failed: 'Devin 登录状态不可用，请先在 Devin 中完成登录。',
    process_exited: 'Devin ACP 进程已经退出，可以重新连接。',
    invalid_request: '这项操作当前不可用，请检查会话状态。',
    unknown: 'Devin 接入暂时不可用，可以停止后重试。'
  }[code]
}

function observationPhase(phase: DevinHostSnapshot['phase']): string | null {
  switch (phase) {
    case 'starting':
      return '正在连接'
    case 'connected':
      return '等待任务'
    case 'running':
      return '正在执行'
    case 'waiting_permission':
      return '等待权限确认'
    case 'stopping':
      return '正在停止'
    default:
      return null
  }
}

export function spawnDevinAcpProcess(
  resources: Extract<DevinAcpResources, { available: true }>,
  runtime: RuntimeStatus
): HostChildProcess {
  return spawn(process.execPath, [resources.proxyPath, resources.devinPath, 'acp'], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      ...(runtime.url ? { DAO_ACP_API_URL: runtime.url } : {})
    },
    stdio: ['pipe', 'pipe', 'pipe']
  })
}

export function createDevinAcpHost(input: DevinAcpHostInput): DevinAcpHost {
  const id = input.id ?? newId
  const now = input.now ?? Date.now
  const listeners = new Set<(snapshot: DevinHostSnapshot) => void>()
  const workspacePaths = new Map<string, string>()
  let adapter: DevinAcpAdapter | null = null
  let child: HostChildProcess | null = null
  let pendingPermission: PendingPermission | null = null
  let currentPrompt = ''
  let promptInFlight = false
  let stopping = false
  let observationFingerprint = ''
  let lastActivityAt = 0

  const resources = input.resolveResources()
  const runtime = input.runtimeStatus()
  let snapshot: DevinHostSnapshot = {
    phase: !resources.available ? 'unavailable' : runtime.healthy ? 'ready' : 'runtime_offline',
    runtimeHealthy: runtime.healthy,
    devinAvailable: resources.available,
    models: [],
    selectedModel: '',
    events: [],
    droppedEventCount: 0,
    ...(!resources.available
      ? { error: { code: resources.reason, message: fixedError(resources.reason) } }
      : !runtime.healthy
        ? { error: { code: 'runtime_offline' as const, message: fixedError('runtime_offline') } }
        : {})
  }

  function publish(): DevinHostSnapshot {
    const safe = cloneSnapshot(snapshot)
    for (const listener of listeners) listener(cloneSnapshot(safe))
    return safe
  }

  function update(next: Partial<DevinHostSnapshot>): DevinHostSnapshot {
    snapshot = { ...snapshot, ...next }
    return publish()
  }

  function readiness(): { resources: DevinAcpResources; runtime: RuntimeStatus } {
    const nextResources = input.resolveResources()
    const nextRuntime = input.runtimeStatus()
    const idle = ['unavailable', 'runtime_offline', 'ready', 'stopped', 'failed'].includes(
      snapshot.phase
    )
    if (idle && !adapter && !child) {
      snapshot = {
        ...snapshot,
        phase: !nextResources.available
          ? 'unavailable'
          : nextRuntime.healthy
            ? snapshot.phase === 'stopped'
              ? 'stopped'
              : 'ready'
            : 'runtime_offline',
        runtimeHealthy: nextRuntime.healthy,
        devinAvailable: nextResources.available,
        error: !nextResources.available
          ? { code: nextResources.reason, message: fixedError(nextResources.reason) }
          : !nextRuntime.healthy
            ? { code: 'runtime_offline', message: fixedError('runtime_offline') }
            : undefined
      }
    }
    return { resources: nextResources, runtime: nextRuntime }
  }

  function fail(code: DevinHostErrorCode): DevinHostSnapshot {
    return update({
      phase: 'failed',
      permission: undefined,
      error: { code, message: fixedError(code) }
    })
  }

  function resolvePending(response: RequestPermissionResponse): void {
    const pending = pendingPermission
    pendingPermission = null
    snapshot = { ...snapshot, permission: undefined }
    pending?.resolve(response)
  }

  async function onPermission(
    request: RequestPermissionRequest
  ): Promise<RequestPermissionResponse> {
    if (!promptInFlight || stopping) return { outcome: { outcome: 'cancelled' } }
    if (pendingPermission) resolvePending({ outcome: { outcome: 'cancelled' } })
    const permissionId = id()
    const allowOnceOption =
      request.options.find((option) => option.kind === 'allow_once')?.optionId ?? ''
    const rejectOption =
      request.options.find((option) => option.kind === 'reject_once')?.optionId ??
      request.options.find((option) => option.kind === 'reject_always')?.optionId ??
      ''
    return new Promise<RequestPermissionResponse>((resolve) => {
      lastActivityAt = now()
      pendingPermission = { id: permissionId, allowOnceOption, rejectOption, resolve }
      update({
        phase: 'waiting_permission',
        permission: projectPermission(request, permissionId),
        error: undefined
      })
    })
  }

  function onUpdate(notification: SessionNotification): void {
    lastActivityAt = now()
    const event = projectAcpUpdate(notification, lastActivityAt, { prompt: currentPrompt, id })
    if (!event) return
    const bounded = appendBoundedHostEvent(snapshot, event)
    update({ ...bounded })
  }

  function attachChildExit(expected: HostChildProcess): void {
    expected.once('exit', () => {
      if (child !== expected) return
      child = null
      adapter = null
      if (stopping || snapshot.phase === 'stopped') return
      resolvePending({ outcome: { outcome: 'cancelled' } })
      fail('process_exited')
    })
  }

  async function terminateChild(target: HostChildProcess | null): Promise<void> {
    if (!target || target.exitCode !== null) return
    const exited = new Promise<boolean>((resolve) => {
      const onExit = () => {
        clearTimeout(timer)
        resolve(true)
      }
      const timer = setTimeout(() => {
        target.off('exit', onExit)
        resolve(false)
      }, 2_000)
      target.once('exit', onExit)
    })
    target.kill('SIGTERM')
    if (!(await exited) && target.exitCode === null) target.kill('SIGKILL')
  }

  return {
    status() {
      readiness()
      return cloneSnapshot(snapshot)
    },

    async chooseWorkspace() {
      const selected = await input.chooseDirectory()
      if (!selected) return null
      const handle = id()
      workspacePaths.clear()
      workspacePaths.set(handle, selected)
      const workspace = {
        handle,
        label: sanitizeDisplayText(basename(selected), '已选择目录', 120)
      }
      update({ workspace, error: undefined })
      return workspace
    },

    async openNative({ workspaceHandle }) {
      const workspacePath = workspacePaths.get(workspaceHandle)
      if (!workspacePath) throw new Error('工作目录选择已失效，请重新选择')
      await (input.openNative ?? launchNativeDevin)(workspacePath)
      return { ok: true }
    },

    async start({ workspaceHandle }) {
      if (
        adapter ||
        child ||
        ['starting', 'connected', 'running', 'waiting_permission'].includes(snapshot.phase)
      ) {
        throw new Error('已有 Devin 会话，请先停止')
      }
      const workspacePath = workspacePaths.get(workspaceHandle)
      if (!workspacePath) throw new Error('工作目录选择已失效，请重新选择')
      const current = readiness()
      if (!current.resources.available) throw new Error(fixedError(current.resources.reason))
      if (!current.runtime.healthy) throw new Error(fixedError('runtime_offline'))

      update({
        phase: 'starting',
        runtimeHealthy: true,
        devinAvailable: true,
        models: [],
        selectedModel: '',
        permission: undefined,
        error: undefined
      })
      const nextChild = (input.spawnProcess ?? spawnDevinAcpProcess)(
        current.resources,
        current.runtime
      )
      child = nextChild
      attachChildExit(nextChild)
      const nextAdapter = (input.createAdapter ?? createDevinAcpAdapter)({
        child: nextChild,
        onPermission,
        onUpdate
      })
      adapter = nextAdapter
      try {
        const created = await nextAdapter.start(workspacePath)
        if (adapter !== nextAdapter) throw new Error('Devin ACP 会话已停止')
        const models = projectModelOptions(created.configOptions)
        observationFingerprint = `devin-host-${workspaceHandle.slice(0, 12)}`
        lastActivityAt = now()
        return update({
          phase: 'connected',
          models: models.options,
          selectedModel: created.currentModel || models.currentValue,
          error: undefined
        })
      } catch {
        adapter = null
        child = null
        await nextAdapter.stop().catch(() => undefined)
        await terminateChild(nextChild)
        return fail('protocol_error')
      }
    },

    async prompt({ prompt, model }) {
      if (!adapter || snapshot.phase !== 'connected') throw new Error('请先连接 Devin 会话')
      if (!prompt.trim()) throw new Error('请输入任务内容')
      if (model) {
        if (!snapshot.models.some((option) => option.value === model))
          throw new Error('模型选项无效')
        if (model !== snapshot.selectedModel) {
          const selected = await adapter.selectModel(model)
          const projected = projectModelOptions(selected.configOptions)
          update({
            models: projected.options.length ? projected.options : snapshot.models,
            selectedModel: selected.currentModel || model
          })
        }
      }
      currentPrompt = prompt
      promptInFlight = true
      lastActivityAt = now()
      const currentAdapter = adapter
      update({ phase: 'running', permission: undefined, error: undefined })
      try {
        await currentAdapter.prompt(prompt)
        lastActivityAt = now()
        if (!stopping && adapter === currentAdapter) {
          return update({ phase: 'connected', permission: undefined, error: undefined })
        }
        return cloneSnapshot(snapshot)
      } catch {
        if (stopping || adapter !== currentAdapter) return cloneSnapshot(snapshot)
        return fail('protocol_error')
      } finally {
        currentPrompt = ''
        promptInFlight = false
      }
    },

    async respondPermission({ permissionId, decision }) {
      const pending = pendingPermission
      if (!pending || pending.id !== permissionId) throw new Error('权限请求已失效')
      if (decision === 'allow_once') {
        if (!pending.allowOnceOption) throw new Error('此工具不支持只允许一次')
        resolvePending({
          outcome: { outcome: 'selected', optionId: pending.allowOnceOption }
        })
      } else if (pending.rejectOption) {
        resolvePending({ outcome: { outcome: 'selected', optionId: pending.rejectOption } })
      } else {
        resolvePending({ outcome: { outcome: 'cancelled' } })
      }
      lastActivityAt = now()
      return update({ phase: promptInFlight ? 'running' : 'connected', permission: undefined })
    },

    async cancel() {
      if (!adapter || (!promptInFlight && snapshot.phase !== 'waiting_permission')) {
        throw new Error('当前没有可取消的 Devin 任务')
      }
      resolvePending({ outcome: { outcome: 'cancelled' } })
      await adapter.cancel()
      lastActivityAt = now()
      return update({ phase: 'connected', permission: undefined })
    },

    async stop() {
      if (stopping) return cloneSnapshot(snapshot)
      if (!adapter && !child) {
        if (snapshot.phase !== 'stopped') update({ phase: 'stopped', permission: undefined })
        return cloneSnapshot(snapshot)
      }
      stopping = true
      update({ phase: 'stopping', permission: undefined })
      resolvePending({ outcome: { outcome: 'cancelled' } })
      const currentAdapter = adapter
      const currentChild = child
      adapter = null
      child = null
      try {
        await currentAdapter?.stop().catch(() => undefined)
        await terminateChild(currentChild)
      } finally {
        stopping = false
        promptInFlight = false
        currentPrompt = ''
        lastActivityAt = 0
        update({
          phase: 'stopped',
          models: [],
          selectedModel: '',
          permission: undefined,
          error: undefined
        })
      }
      return cloneSnapshot(snapshot)
    },

    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },

    observationSession() {
      const observedAt = now()
      const phase = observationPhase(snapshot.phase)
      if (
        !observationFingerprint ||
        !lastActivityAt ||
        observedAt - lastActivityAt > 5 * 60_000 ||
        !phase
      ) {
        return null
      }
      const requestInFlight =
        snapshot.phase === 'running' || snapshot.phase === 'waiting_permission'
      return {
        id: observationFingerprint,
        source: 'devin-host',
        surface: 'devin',
        identityKind: 'native',
        mode: 'acp-host',
        activation: 'active',
        active: true,
        lifecycle: 'active',
        stale: false,
        warning: snapshot.phase === 'waiting_permission',
        updatedAt: lastActivityAt,
        observedAt,
        latestActivityAt: lastActivityAt,
        freshnessMs: Math.max(0, observedAt - lastActivityAt),
        requestInFlight,
        goal: snapshot.phase === 'connected' ? '等待你发送任务' : phase,
        phase,
        workspace: snapshot.workspace?.label || '',
        todo: { completed: 0, total: 0, current: '' },
        verification: { status: 'unknown', blocking: false },
        failures: {
          maxConsecutive: 0,
          sameCallStreak: 0,
          lastToolOk: null,
          hasLastError: false
        },
        route: {
          modelUid: snapshot.selectedModel,
          provider: 'FOMO FLOW',
          upstreamModel: '',
          provisional: false
        },
        telemetry: {
          reasoningTokens: 0,
          compactions: 0,
          ttftMs: null,
          durationMs: null,
          modelPath: 'routed',
          loopSource: 'devin-host'
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
  }
}
