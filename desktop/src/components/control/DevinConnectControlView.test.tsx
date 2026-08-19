// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { DesktopHost, DevinHostSnapshot } from '@/lib/desktopHost'

import { DevinConnectControlView } from './DevinConnectControlView'

const ready: DevinHostSnapshot = {
  phase: 'ready',
  runtimeHealthy: true,
  devinAvailable: true,
  models: [],
  selectedModel: '',
  events: [],
  droppedEventCount: 0
}

function hostFixture(
  snapshot: DevinHostSnapshot = ready,
  overrides: Partial<DesktopHost> = {}
): DesktopHost {
  return {
    getRuntimeStatus: async () => ({
      healthy: true,
      running: true,
      port: 54500,
      url: 'http://127.0.0.1:54500',
      profile: 'desktop',
      imported: { config: true, revproxy: true },
      error: null
    }),
    retryRuntime: async () => ({
      healthy: true,
      running: true,
      port: 54500,
      url: 'http://127.0.0.1:54500',
      profile: 'desktop',
      imported: { config: true, revproxy: true },
      error: null
    }),
    getDashboardSnapshot: async () => ({}) as never,
    openExternal: async () => undefined,
    openConfig: async () => undefined,
    openControlConsole: async () => undefined,
    requestControl: async () => ({ ok: true, status: 200, data: {} }),
    saveHandoff: async () => ({ ok: true }),
    writeClipboard: async () => undefined,
    getDevinHostStatus: vi.fn(async () => snapshot),
    chooseDevinWorkspace: vi.fn(async () => ({
      handle: 'a'.repeat(32),
      label: 'dao-project'
    })),
    openDevinNative: vi.fn(async () => ({ ok: true as const })),
    startDevinHost: vi.fn(async () => snapshot),
    promptDevinHost: vi.fn(async () => snapshot),
    respondDevinPermission: vi.fn(async () => snapshot),
    cancelDevinHost: vi.fn(async () => snapshot),
    stopDevinHost: vi.fn(async () => ({ ...snapshot, phase: 'stopped' as const })),
    subscribeDevinHost: vi.fn(() => () => undefined),
    ...overrides
  }
}

afterEach(() => {
  cleanup()
  delete window.desktopHost
})

describe('Devin connection view', () => {
  it('explains readiness and performs no session or routing action on mount', async () => {
    const host = hostFixture()
    window.desktopHost = host
    render(<DevinConnectControlView />)

    expect(await screen.findByText('可以打开 Devin')).toBeInTheDocument()
    expect(screen.getByText(/默认进入 Devin 原生窗口/)).toBeInTheDocument()
    expect(screen.getByText('Devin App')).toBeInTheDocument()
    expect(screen.getByText('托管 ACP 模型')).toBeInTheDocument()
    expect(screen.getByText('托管 ACP 权限')).toBeInTheDocument()
    expect(screen.getByText(/FOMO FLOW 只负责打开窗口和观测本机事实/)).toBeInTheDocument()
    expect(screen.getByText(/需要直接在 FOMO FLOW 内发送任务/)).toBeInTheDocument()
    expect(host.startDevinHost).not.toHaveBeenCalled()
    expect(host.promptDevinHost).not.toHaveBeenCalled()
    expect(host.respondDevinPermission).not.toHaveBeenCalled()
  })

  it('selects a safe directory, connects explicitly, then shows returned model choices', async () => {
    const connected: DevinHostSnapshot = {
      ...ready,
      phase: 'connected',
      workspace: { handle: 'a'.repeat(32), label: 'dao-project' },
      models: [
        { value: 'dao-gpt-5-6-sol', label: 'Dao GPT 5.6 Sol' },
        { value: 'dao-opus-5', label: 'Dao Opus 5' }
      ],
      selectedModel: 'dao-gpt-5-6-sol'
    }
    const getStatus = vi
      .fn<NonNullable<DesktopHost['getDevinHostStatus']>>()
      .mockResolvedValueOnce(ready)
      .mockResolvedValue(connected)
    const host = hostFixture(connected, {
      getDevinHostStatus: getStatus,
      startDevinHost: vi.fn(async () => connected)
    })
    window.desktopHost = host
    render(<DevinConnectControlView />)

    await screen.findByText('可以打开 Devin')
    fireEvent.click(screen.getByRole('button', { name: '选择工作目录' }))
    expect(await screen.findByText('dao-project')).toBeInTheDocument()
    expect(document.body.textContent).not.toContain('/Users/')
    expect(document.body.textContent).not.toContain('a'.repeat(32))

    fireEvent.click(screen.getByRole('button', { name: '高级：在 FOMO FLOW 托管 ACP' }))
    await waitFor(() => expect(host.startDevinHost).toHaveBeenCalledWith('a'.repeat(32)))
    expect(await screen.findByLabelText('本会话使用的模型')).toHaveValue('dao-gpt-5-6-sol')
    expect(screen.getByText('当前模型：Dao GPT 5.6 Sol')).toBeInTheDocument()
  })

  it('opens native Devin by default without starting the hosted ACP client', async () => {
    const openDevinNative = vi.fn(async () => ({ ok: true as const }))
    const startDevinHost = vi.fn(async () => ready)
    const host = hostFixture(ready, { openDevinNative, startDevinHost })
    window.desktopHost = host
    render(<DevinConnectControlView />)

    await screen.findByText('可以打开 Devin')
    fireEvent.click(screen.getByRole('button', { name: '选择工作目录' }))
    fireEvent.click(await screen.findByRole('button', { name: '打开 Devin 原生窗口' }))

    await waitFor(() => expect(openDevinNative).toHaveBeenCalledWith('a'.repeat(32)))
    expect(startDevinHost).not.toHaveBeenCalled()
    expect(screen.getByText(/已打开 Devin 原生窗口.*请在 Devin 中发送任务/)).toBeInTheDocument()
  })

  it('keeps hosted ACP behind an explicit advanced action', async () => {
    const connected: DevinHostSnapshot = {
      ...ready,
      phase: 'connected',
      workspace: { handle: 'a'.repeat(32), label: 'dao-project' }
    }
    const startDevinHost = vi.fn(async () => connected)
    const host = hostFixture(ready, { startDevinHost })
    window.desktopHost = host
    render(<DevinConnectControlView />)

    await screen.findByText('可以打开 Devin')
    fireEvent.click(screen.getByRole('button', { name: '选择工作目录' }))
    fireEvent.click(await screen.findByRole('button', { name: '高级：在 FOMO FLOW 托管 ACP' }))

    await waitFor(() => expect(startDevinHost).toHaveBeenCalledWith('a'.repeat(32)))
  })

  it('sends a prompt only after explicit click and never renders it in the event board', async () => {
    const connected: DevinHostSnapshot = {
      ...ready,
      phase: 'connected',
      workspace: { handle: 'b'.repeat(32), label: 'dao-project' },
      models: [{ value: 'dao-opus-5', label: 'Dao Opus 5' }],
      selectedModel: 'dao-opus-5',
      events: [
        {
          id: 'c'.repeat(32),
          kind: 'message',
          message: '已完成安全检查。',
          status: 'completed',
          at: 1_700_000_000_000
        }
      ]
    }
    const promptDevinHost = vi.fn(async () => connected)
    window.desktopHost = hostFixture(connected, { promptDevinHost })
    render(<DevinConnectControlView />)

    const input = await screen.findByLabelText('告诉 Devin 要完成什么')
    fireEvent.change(input, { target: { value: 'private prompt' } })
    expect(promptDevinHost).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '发送给 Devin' }))
    await waitFor(() =>
      expect(promptDevinHost).toHaveBeenCalledWith('private prompt', 'dao-opus-5')
    )
    expect(screen.getByText('已完成安全检查。')).toBeInTheDocument()
    expect(screen.queryByText('private prompt')).not.toBeInTheDocument()
  })

  it('offers only allow-once and reject for a safe permission card', async () => {
    const waiting: DevinHostSnapshot = {
      ...ready,
      phase: 'waiting_permission',
      workspace: { handle: 'd'.repeat(32), label: 'dao-project' },
      permission: {
        id: 'e'.repeat(32),
        category: '运行本地命令',
        message: 'Devin 请求运行本地命令。请确认是否只允许这一次。',
        allowOnce: true
      }
    }
    const respond = vi.fn(async () => ({
      ...waiting,
      phase: 'running' as const,
      permission: undefined
    }))
    window.desktopHost = hostFixture(waiting, { respondDevinPermission: respond })
    render(<DevinConnectControlView />)

    expect(await screen.findByText(waiting.permission!.message)).toBeInTheDocument()
    expect(screen.queryByText(/始终允许/)).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '允许一次' }))
    await waitFor(() => expect(respond).toHaveBeenCalledWith('e'.repeat(32), 'allow_once'))
  })

  it('shows cancel only while running and stop only for a created session', async () => {
    const running: DevinHostSnapshot = {
      ...ready,
      phase: 'running',
      workspace: { handle: 'f'.repeat(32), label: 'dao-project' }
    }
    const cancel = vi.fn(async () => ({ ...running, phase: 'connected' as const }))
    const stop = vi.fn(async () => ({ ...running, phase: 'stopped' as const }))
    window.desktopHost = hostFixture(running, {
      cancelDevinHost: cancel,
      stopDevinHost: stop
    })
    render(<DevinConnectControlView />)

    fireEvent.click(await screen.findByRole('button', { name: '取消当前任务' }))
    await waitFor(() => expect(cancel).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByRole('button', { name: '停止 Devin 会话' }))
    await waitFor(() => expect(stop).toHaveBeenCalledTimes(1))
  })
})
