import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'

import type {
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification
} from '@agentclientprotocol/sdk'
import type { DevinHostSnapshot } from '../../src/lib/desktopHost/devinAcpHost'
import type { DevinAcpAdapter } from './devin-acp-adapter'
import { createDevinAcpHost, type DevinAcpHostInput, type HostChildProcess } from './devin-acp-host'

function ids() {
  let value = 0
  return () => (++value).toString(16).padStart(32, '0')
}

function childFixture() {
  const fixture = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    killed: false,
    exitCode: null as number | null,
    kill: vi.fn<(signal?: NodeJS.Signals | number) => boolean>()
  })
  fixture.kill.mockImplementation((signal?: NodeJS.Signals | number) => {
    fixture.killed = true
    queueMicrotask(() => fixture.emit('exit', signal === 'SIGKILL' ? 137 : 0, signal ?? null))
    return true
  })
  return fixture as unknown as HostChildProcess
}

function hostFixture(overrides: Partial<DevinAcpHostInput> = {}) {
  const child = childFixture()
  let callbacks:
    | {
        onPermission(request: RequestPermissionRequest): Promise<RequestPermissionResponse>
        onUpdate(update: SessionNotification): void | Promise<void>
      }
    | undefined
  const adapter: DevinAcpAdapter = {
    start: vi.fn<DevinAcpAdapter['start']>(async () => ({
      currentModel: 'dao-gpt-5-6-sol',
      configOptions: [
        {
          id: 'model',
          name: 'Model',
          category: 'model',
          type: 'select' as const,
          currentValue: 'dao-gpt-5-6-sol',
          options: [
            { value: 'dao-gpt-5-6-sol', name: 'Dao GPT 5.6 Sol' },
            { value: 'dao-opus-5', name: 'Dao Opus 5' }
          ]
        }
      ]
    })),
    selectModel: vi.fn<DevinAcpAdapter['selectModel']>(async (model) => ({
      currentModel: model,
      configOptions: []
    })),
    prompt: vi.fn<DevinAcpAdapter['prompt']>(async () => ({ stopReason: 'end_turn' })),
    cancel: vi.fn<DevinAcpAdapter['cancel']>(async () => undefined),
    stop: vi.fn<DevinAcpAdapter['stop']>(async () => undefined)
  }
  const input: DevinAcpHostInput = {
    chooseDirectory: async () => '/Users/a77/secret-workspace',
    createAdapter: (adapterInput) => {
      callbacks = adapterInput
      return adapter
    },
    id: ids(),
    now: () => 1_700_000_000_000,
    resolveResources: () => ({
      available: true,
      devinPath:
        '/Applications/Devin.app/Contents/Resources/app/extensions/windsurf/devin/bin/devin',
      proxyPath: '/safe/proxy.js'
    }),
    runtimeStatus: () => ({ healthy: true, url: 'http://127.0.0.1:54500' }),
    spawnProcess: () => child,
    ...overrides
  }
  const host = createDevinAcpHost(input)
  return {
    adapter,
    child,
    host,
    callbacks: () => callbacks!
  }
}

async function connectedHost(fixture = hostFixture()) {
  const workspace = await fixture.host.chooseWorkspace()
  expect(workspace).not.toBeNull()
  await fixture.host.start({ workspaceHandle: workspace!.handle })
  return { ...fixture, workspace: workspace! }
}

describe('Devin ACP host', () => {
  it('reports fixed resource and runtime readiness without exposing paths', () => {
    const unavailable = hostFixture({
      resolveResources: () => ({ available: false, reason: 'devin_missing' })
    }).host.status()
    expect(unavailable).toMatchObject({ phase: 'unavailable', devinAvailable: false })
    expect(JSON.stringify(unavailable)).not.toContain('/Applications')

    const offline = hostFixture({
      runtimeStatus: () => ({ healthy: false, url: null })
    }).host.status()
    expect(offline).toMatchObject({ phase: 'runtime_offline', runtimeHealthy: false })
  })

  it('keeps the selected directory main-only and enforces one active session', async () => {
    const fixture = hostFixture()
    const workspace = await fixture.host.chooseWorkspace()
    expect(workspace).toEqual({
      handle: '00000000000000000000000000000001',
      label: 'secret-workspace'
    })
    expect(JSON.stringify(workspace)).not.toContain('/Users/')

    const snapshot = await fixture.host.start({ workspaceHandle: workspace!.handle })
    expect(snapshot).toMatchObject({
      phase: 'connected',
      selectedModel: 'dao-gpt-5-6-sol',
      workspace
    })
    expect(snapshot.models).toContainEqual({ value: 'dao-opus-5', label: 'Dao Opus 5' })
    expect(fixture.adapter.start).toHaveBeenCalledWith('/Users/a77/secret-workspace')
    await expect(fixture.host.start({ workspaceHandle: workspace!.handle })).rejects.toThrow(
      '已有 Devin 会话'
    )
  })

  it('opens native Devin with the main-process workspace path only', async () => {
    const openNative = vi.fn(async () => undefined)
    const fixture = hostFixture({ openNative })
    const workspace = await fixture.host.chooseWorkspace()

    await expect(fixture.host.openNative({ workspaceHandle: workspace!.handle })).resolves.toEqual({
      ok: true
    })
    expect(openNative).toHaveBeenCalledWith('/Users/a77/secret-workspace')
    await expect(fixture.host.openNative({ workspaceHandle: 'f'.repeat(32) })).rejects.toThrow(
      '工作目录选择已失效'
    )
  })

  it('selects only a returned model for the prompt and never changes global priority', async () => {
    const fixture = await connectedHost()
    const snapshot = await fixture.host.prompt({ prompt: 'private prompt', model: 'dao-opus-5' })
    expect(fixture.adapter.selectModel).toHaveBeenCalledWith('dao-opus-5')
    expect(fixture.adapter.prompt).toHaveBeenCalledWith('private prompt')
    expect(snapshot.phase).toBe('connected')
    expect(JSON.stringify(snapshot)).not.toContain('private prompt')
  })

  it('projects permission to a local id and resolves only allow-once or rejection', async () => {
    const fixture = await connectedHost()
    let permissionResponse: RequestPermissionResponse | undefined
    const prompt = vi.mocked(fixture.adapter.prompt)
    prompt.mockImplementationOnce(async () => {
      permissionResponse = await fixture.callbacks().onPermission({
        sessionId: 'raw-session',
        toolCall: {
          toolCallId: 'raw-tool',
          title: 'Run /etc/private',
          kind: 'execute',
          status: 'pending',
          rawInput: { command: 'cat /etc/private' }
        },
        options: [
          { optionId: 'raw-allow', name: 'Allow', kind: 'allow_once' },
          { optionId: 'raw-always', name: 'Always', kind: 'allow_always' },
          { optionId: 'raw-reject', name: 'Reject', kind: 'reject_once' }
        ]
      })
      return { stopReason: 'end_turn' }
    })

    const promptPromise = fixture.host.prompt({ prompt: 'private prompt' })
    await vi.waitFor(() => expect(fixture.host.status().phase).toBe('waiting_permission'))
    const permission = fixture.host.status().permission!
    expect(JSON.stringify(permission)).not.toContain('raw-')
    expect(JSON.stringify(permission)).not.toContain('/etc')
    await fixture.host.respondPermission({ permissionId: permission.id, decision: 'allow_once' })
    await promptPromise
    expect(permissionResponse).toEqual({
      outcome: { outcome: 'selected', optionId: 'raw-allow' }
    })
    await expect(
      fixture.host.respondPermission({ permissionId: permission.id, decision: 'reject' })
    ).rejects.toThrow('权限请求已失效')
  })

  it('bounds streamed events and does not expose prompt or protocol identities', async () => {
    const fixture = await connectedHost()
    for (let index = 0; index < 250; index += 1) {
      await fixture.callbacks().onUpdate({
        sessionId: 'raw-session',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: `safe update ${index} /Users/private` },
          messageId: `raw-message-${index}`
        }
      })
    }
    const snapshot = fixture.host.status()
    expect(snapshot.events).toHaveLength(200)
    expect(snapshot.droppedEventCount).toBe(50)
    expect(JSON.stringify(snapshot)).not.toContain('/Users/private')
    expect(JSON.stringify(snapshot)).not.toContain('raw-session')
    expect(JSON.stringify(snapshot)).not.toContain('raw-message')
  })

  it('rejects pending permission and terminates the exact child idempotently', async () => {
    const fixture = await connectedHost()
    let permissionResponse: RequestPermissionResponse | undefined
    vi.mocked(fixture.adapter.prompt).mockImplementationOnce(async () => {
      permissionResponse = await fixture.callbacks().onPermission({
        sessionId: 'raw-session',
        toolCall: { toolCallId: 'raw-tool', title: 'Read', kind: 'read' },
        options: [{ optionId: 'raw-allow', name: 'Allow', kind: 'allow_once' }]
      })
      return { stopReason: 'cancelled' }
    })
    const promptPromise = fixture.host.prompt({ prompt: 'secret' })
    await vi.waitFor(() => expect(fixture.host.status().phase).toBe('waiting_permission'))
    await fixture.host.stop()
    await promptPromise
    await fixture.host.stop()
    expect(permissionResponse).toEqual({ outcome: { outcome: 'cancelled' } })
    expect(fixture.adapter.stop).toHaveBeenCalledTimes(1)
    expect(fixture.child.kill).toHaveBeenCalledWith('SIGTERM')
    expect(fixture.host.status().phase).toBe('stopped')
  })

  it('supports subscriptions with safe snapshots and unsubscribe', async () => {
    const fixture = hostFixture()
    const snapshots: DevinHostSnapshot[] = []
    const unsubscribe = fixture.host.subscribe((snapshot) => snapshots.push(snapshot))
    await fixture.host.chooseWorkspace()
    unsubscribe()
    await fixture.host.chooseWorkspace()
    expect(snapshots).toHaveLength(1)
    expect(JSON.stringify(snapshots)).not.toContain('/Users/')
  })

  it('publishes a safe hosted-session fact and retires it after five minutes without stopping', async () => {
    let now = 1_700_000_000_000
    const fixture = await connectedHost(hostFixture({ now: () => now }))

    expect(fixture.host.observationSession()).toMatchObject({
      source: 'devin-host',
      surface: 'devin',
      active: true,
      workspace: 'secret-workspace',
      goal: '等待你发送任务',
      route: { modelUid: 'dao-gpt-5-6-sol', provider: 'FOMO FLOW' }
    })
    const rendered = JSON.stringify(fixture.host.observationSession())
    expect(rendered).not.toContain('/Users/')
    expect(rendered).not.toContain('fake-devin-session')

    now += 5 * 60_000 + 1
    expect(fixture.host.observationSession()).toBeNull()
    expect(fixture.adapter.stop).not.toHaveBeenCalled()
  })
})
