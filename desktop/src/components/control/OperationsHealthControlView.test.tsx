// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { DaoDesktopStatus, DesktopHost, TaskboardSnapshot } from '@/lib/desktopHost'
import { OperationsHealthControlView } from './OperationsHealthControlView'

function installHost(overrides: Partial<DesktopHost> = {}): DesktopHost {
  const healthyStatus: DaoDesktopStatus = {
    healthy: true,
    running: true,
    port: 54500,
    url: 'http://127.0.0.1:54500',
    profile: 'desktop',
    imported: { config: true, revproxy: false },
    error: null
  }
  const taskboardSnapshot: TaskboardSnapshot = {
    state: 'connected',
    writable: false,
    message: '只读连接',
    items: []
  }
  const host: DesktopHost = {
    getRuntimeStatus: vi.fn(async () => healthyStatus),
    retryRuntime: vi.fn(async () => healthyStatus),
    getDashboardSnapshot: vi.fn(async () => ({}) as never),
    openExternal: async () => undefined,
    openConfig: async () => undefined,
    openControlConsole: async () => undefined,
    requestControl: vi.fn(async (path) => {
      if (path !== '/origin/hud/snapshot') throw new Error(`unexpected ${path}`)
      return {
        ok: true,
        status: 200,
        data: {
          version: 1,
          generatedAt: Date.now(),
          runtime: { healthy: true, port: 54500, connection: 'live' },
          providers: [{ id: 'private-provider', state: 'alive' }],
          sessions: [
            {
              id: 'private-session',
              surface: 'codex',
              active: true,
              latestActivityAt: Date.now(),
              workspace: '/Users/private/project'
            }
          ],
          recentRequests: [
            {
              id: 'private-request',
              at: Date.now(),
              provider: 'cccc',
              model: 'gpt-5.6',
              prompt: 'private prompt',
              Authorization: 'Bearer private-token'
            }
          ]
        }
      }
    }),
    saveHandoff: async () => ({ ok: true }),
    writeClipboard: async () => undefined,
    getTaskboardSnapshot: vi.fn(async () => taskboardSnapshot),
    ...overrides
  }
  window.desktopHost = host
  return host
}

afterEach(() => {
  cleanup()
  delete window.desktopHost
})

describe('operations health control view', () => {
  it('shows the six safe local health dimensions using only existing reads', async () => {
    const host = installHost()
    render(<OperationsHealthControlView />)

    expect(await screen.findByRole('heading', { name: '运行健康' })).toBeInTheDocument()
    for (const label of [
      '本地运行时',
      '观测数据源',
      '上游渠道',
      'Agent 会话',
      '请求观测',
      'Taskboard'
    ]) {
      expect(screen.getByText(label)).toBeInTheDocument()
    }
    expect(host.requestControl).toHaveBeenCalledTimes(1)
    expect(host.requestControl).toHaveBeenCalledWith('/origin/hud/snapshot', 'GET', undefined)
    expect(host.getRuntimeStatus).toHaveBeenCalledTimes(1)
    expect(host.getTaskboardSnapshot).toHaveBeenCalledTimes(1)
    expect(document.body.textContent).not.toMatch(
      /private-provider|private-session|private-request|private prompt|private-token|\/Users\/private|cccc|gpt-5\.6/
    )
  })

  it('keeps healthy runtime facts visible when an auxiliary source fails', async () => {
    installHost({
      requestControl: vi.fn(async () => {
        throw new Error('private HUD error')
      }),
      getTaskboardSnapshot: vi.fn(async () => {
        throw new Error('private taskboard error')
      })
    })
    render(<OperationsHealthControlView />)

    expect((await screen.findAllByText('运行中 · 本机端口 54500')).length).toBeGreaterThan(0)
    expect(screen.getByText('部分数据源暂不可用，其余健康事实仍可查看。')).toBeInTheDocument()
    expect(document.body.textContent).not.toContain('private HUD error')
    expect(document.body.textContent).not.toContain('private taskboard error')
    await waitFor(() => expect(screen.getAllByText('尚未观测').length).toBeGreaterThan(0))
  })
})
