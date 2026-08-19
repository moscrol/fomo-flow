// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { DesktopHost } from '@/lib/desktopHost'

import { ObservabilityControlView } from './ObservabilityControlView'

function installHost(requestControl: DesktopHost['requestControl']) {
  window.desktopHost = {
    getRuntimeStatus: async () => ({
      healthy: true,
      running: true,
      port: 8955,
      url: 'http://127.0.0.1:8955',
      profile: 'desktop',
      imported: { config: false, revproxy: false },
      error: null
    }),
    retryRuntime: async () => ({
      healthy: true,
      running: true,
      port: 8955,
      url: 'http://127.0.0.1:8955',
      profile: 'desktop',
      imported: { config: false, revproxy: false },
      error: null
    }),
    getDashboardSnapshot: async () => ({
      refreshedAt: Date.now(),
      partial: false,
      availableModelCount: 1,
      routerReady: true,
      eaRunning: true,
      familyTierExtend: false,
      providers: [],
      routes: [],
      usage: { calls: 0, input: 0, output: 0, total: 0 },
      failureProviders: [],
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
      }
    }),
    openExternal: async () => undefined,
    openConfig: async () => undefined,
    openControlConsole: async () => undefined,
    requestControl,
    saveHandoff: async () => ({ ok: true }),
    writeClipboard: async () => undefined
  }
}

afterEach(() => {
  delete window.desktopHost
})

describe('native observability control view', () => {
  it('renders advisory routing snapshots without changing dispatch order', async () => {
    const user = userEvent.setup()
    const requestControl = vi.fn(async (path: string) => {
      if (path.startsWith('/origin/ea/routing-decisions')) {
        return {
          ok: true,
          status: 200,
          data: {
            ok: true,
            decisions: [
              {
                id: 'route-1',
                at: '2026-08-09T08:00:00.000Z',
                model: 'dao-opus-5',
                channelStrategy: 'priority',
                profile: 'balanced',
                candidates: [
                  {
                    provider: 'primary',
                    model: 'm1',
                    source: 'primary',
                    actualPriority: 1,
                    advisoryRank: 2,
                    advisoryScore: 0.41,
                    factors: { health: 0.9, cost: 0.2, priority: 1 }
                  },
                  {
                    provider: 'cheap',
                    model: 'm2',
                    source: 'configured-fallback',
                    actualPriority: 2,
                    advisoryRank: 1,
                    advisoryScore: 0.74,
                    factors: { health: 0.7, cost: 0.95, priority: 0.5 }
                  }
                ],
                outcome: {
                  status: 'selected',
                  provider: 'primary',
                  model: 'm1',
                  actualPriority: 1,
                  failureCount: 0
                },
                budget: { status: 'not_requested' }
              }
            ]
          }
        }
      }
      if (path === '/origin/ea/usage') {
        return { ok: true, status: 200, data: { totals: { calls: 2, total: 12 } } }
      }
      if (path.startsWith('/origin/ea/alerts'))
        return { ok: true, status: 200, data: { alerts: [] } }
      if (path === '/origin/ea/failure-stats') return { ok: true, status: 200, data: { stats: {} } }
      if (path.startsWith('/origin/ea/traces'))
        return { ok: true, status: 200, data: { traces: [] } }
      if (path.startsWith('/origin/ea/audit')) return { ok: true, status: 200, data: { audit: [] } }
      if (path === '/origin/ea/config-backups')
        return { ok: true, status: 200, data: { backups: [] } }
      return { ok: false, status: 404, data: { error: `unexpected ${path}` } }
    })
    installHost(requestControl)

    render(<ObservabilityControlView />)

    expect(await screen.findByRole('heading', { name: '问题与数据' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '现在正常吗？' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '刚刚发生了什么？' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '哪个渠道在工作？' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '要不要处理？' })).toBeInTheDocument()
    expect(screen.getByText('路由建议')).toBeInTheDocument()
    expect(screen.getByText('dao-opus-5')).toBeInTheDocument()
    expect(
      screen.getByText(/按你设置的顺序 · primary \/ m1 · 本次请求没有单独预算/)
    ).toBeInTheDocument()
    expect(screen.getByText('实际优先级 #1 primary')).toBeInTheDocument()
    expect(screen.getByText('建议 #1')).toBeInTheDocument()
    const technicalDetails = screen.getByText('查看技术细节').closest('details')
    expect(technicalDetails).toBeInTheDocument()
    expect(technicalDetails).toContainElement(screen.getByText('参考分（不改变真实路由）'))
    expect(technicalDetails).toContainElement(screen.getByText('失败原因'))

    const callsBeforeProfileChange = requestControl.mock.calls.length
    await user.selectOptions(screen.getByLabelText('路由建议 profile'), 'cheap')
    await waitFor(() =>
      expect(requestControl).toHaveBeenCalledWith(
        '/origin/ea/routing-decisions?profile=cheap&limit=20',
        'GET',
        undefined
      )
    )
    expect(
      requestControl.mock.calls
        .slice(callsBeforeProfileChange)
        .every(([path]) => String(path).startsWith('/origin/ea/routing-decisions'))
    ).toBe(true)
  })
})
