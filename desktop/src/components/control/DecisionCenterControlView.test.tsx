// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { DesktopHost } from '@/lib/desktopHost'

import { DecisionCenterControlView } from './DecisionCenterControlView'

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
      availableModelCount: 0,
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
  cleanup()
  delete window.desktopHost
})

describe('Dao decision center', () => {
  it('puts conclusions and real evidence first while keeping preflight optional and manual', async () => {
    const user = userEvent.setup()
    const requestControl = vi.fn<DesktopHost['requestControl']>(async (path, method) => {
      if (path === '/origin/ea/decision-inbox?limit=50') {
        return {
          ok: true,
          status: 200,
          data: {
            ok: true,
            items: [
              {
                id: 'decision-0123456789abcdef01234567',
                classification: 'budget_rejected',
                status: 'open',
                count: 2,
                lastSeenAt: '2026-08-10T03:00:00.000Z',
                evidenceId: 'evidence-222222222222222222222222'
              }
            ]
          }
        }
      }
      if (path === '/origin/ea/route-evidence?limit=50') {
        return {
          ok: true,
          status: 200,
          data: {
            ok: true,
            evidence: [
              {
                id: 'evidence-111111111111111111111111',
                createdAt: '2026-08-10T02:00:00.000Z',
                plan: {},
                events: [
                  {
                    kind: 'attempt',
                    at: '2026-08-10T02:00:00.000Z',
                    provider: '默认证据',
                    model: 'm0'
                  }
                ],
                outcome: { status: 'selected', provider: '默认证据', model: 'm0' }
              },
              {
                id: 'evidence-222222222222222222222222',
                createdAt: '2026-08-10T03:00:00.000Z',
                linkedPreflightPlanId: 'plan-safe',
                plan: {},
                events: [
                  {
                    kind: 'fallback',
                    at: '2026-08-10T03:00:00.000Z',
                    provider: '对应证据',
                    model: 'm2'
                  }
                ],
                outcome: { status: 'selected', provider: '对应证据', model: 'm2' },
                prompt: 'PROMPT_MUST_NOT_RENDER',
                path: '/Users/private/must-not-render'
              }
            ]
          }
        }
      }
      if (path === '/origin/ea/routes') {
        return {
          ok: true,
          status: 200,
          data: {
            routes: {
              MODEL_BACKUP: { provider: '备用渠道', model: 'm2' },
              MODEL_PREFLIGHT: { provider: '规定首选', model: 'm1' }
            }
          }
        }
      }
      if (path === '/origin/ea/route-preflight' && method === 'POST') {
        return {
          ok: true,
          status: 200,
          data: {
            ok: true,
            plan: {
              profile: 'cheap',
              strategy: 'priority',
              configuredOrder: [
                { provider: '规定首选', model: 'm1', actualPriority: 1 },
                { provider: '规定备用', model: 'm2', actualPriority: 2 }
              ],
              dispatchOrder: [{ provider: '规定备用', model: 'm2', actualPriority: 2 }],
              excluded: [
                {
                  provider: '规定首选',
                  model: 'm1',
                  actualPriority: 1,
                  reason: 'circuit_open',
                  circuitCategory: 'rate_limit',
                  remainingMs: 90_000
                }
              ],
              advisoryOrder: [
                { provider: '规定备用', model: 'm2', actualPriority: 2, advisoryRank: 1 }
              ],
              budget: { status: 'within_cap', capUsd: 0.2, fallback: 'strict' },
              warnings: []
            }
          }
        }
      }
      if (path.endsWith('/ack') && method === 'POST') {
        return { ok: true, status: 200, data: { ok: true, item: {} } }
      }
      return { ok: false, status: 404, data: { error: `unexpected ${path}` } }
    })
    installHost(requestControl)
    const onNavigate = vi.fn()

    render(<DecisionCenterControlView onNavigate={onNavigate} />)

    expect(await screen.findByRole('heading', { name: '路由观察与处理' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '现在要不要处理' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '最近请求走了哪里' })).toBeInTheDocument()
    expect(screen.getByText('有 1 项需要处理')).toBeInTheDocument()
    expect(screen.getAllByText('默认证据 · m0').length).toBeGreaterThan(0)
    const optionalCheck = screen.getByText('发送前检查（可选）').closest('details')
    expect(optionalCheck).not.toHaveAttribute('open')
    expect(
      requestControl.mock.calls.some(
        ([path, method]) => path === '/origin/ea/route-preflight' && method === 'POST'
      )
    ).toBe(false)

    expect((await screen.findAllByText('默认证据 · m0')).length).toBeGreaterThan(0)
    await user.click(screen.getByRole('button', { name: '查看证据' }))
    expect(screen.getAllByText('对应证据 · m2').length).toBeGreaterThan(0)
    expect(screen.queryByText('PROMPT_MUST_NOT_RENDER')).not.toBeInTheDocument()
    expect(screen.queryByText(/evidence-2222/)).not.toBeInTheDocument()

    await user.click(screen.getByText('发送前检查（可选）'))
    expect(screen.getByLabelText('已配置模型')).toBeInstanceOf(HTMLSelectElement)
    expect(screen.getByLabelText('使用用途')).toBeInstanceOf(HTMLSelectElement)
    expect(screen.getByLabelText('预算上限')).toBeInstanceOf(HTMLSelectElement)
    await user.selectOptions(screen.getByLabelText('已配置模型'), 'MODEL_PREFLIGHT')
    await user.selectOptions(screen.getByLabelText('使用用途'), 'cheap')
    await user.selectOptions(screen.getByLabelText('预算上限'), '0.2')
    await user.click(screen.getByRole('button', { name: '查看预计路线' }))

    await waitFor(() =>
      expect(requestControl).toHaveBeenCalledWith('/origin/ea/route-preflight', 'POST', {
        model: 'MODEL_PREFLIGHT',
        profile: 'cheap',
        budgetUsd: 0.2,
        budgetFallback: 'strict',
        stream: true,
        usesTools: false,
        thinkingEnabled: false
      })
    )
    expect(screen.getByRole('heading', { name: '规定顺序' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '预计实际尝试' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '参考建议' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '路由接力单' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '路由接力单' }).closest('[aria-live]')).toBeNull()
    expect(screen.getByText('规定 #1 · 规定首选 · m1')).toBeInTheDocument()
    expect(screen.getByText('本次跳过')).toBeInTheDocument()
    expect(screen.getByText('渠道暂时熔断 · 上游限流')).toBeInTheDocument()
    expect(screen.getByText('约 1 分 30 秒后可再尝试')).toBeInTheDocument()
    expect(screen.getByText('可尝试 · 预计第一跳')).toBeInTheDocument()
    expect(screen.getByText('只是预演，不会发送请求或改变优先级。')).toBeInTheDocument()
    expect(screen.getByText(/#1 规定首选/)).toBeInTheDocument()
    expect(screen.getByText(/建议 #1 规定备用/)).toBeInTheDocument()

    await user.selectOptions(screen.getByLabelText('使用用途'), 'reliable')
    expect(screen.queryByRole('heading', { name: '路由接力单' })).not.toBeInTheDocument()
    await user.selectOptions(screen.getByLabelText('使用用途'), 'cheap')

    await user.selectOptions(screen.getByLabelText('预算上限'), '')
    await user.click(screen.getByRole('button', { name: '查看预计路线' }))
    await waitFor(() =>
      expect(requestControl).toHaveBeenCalledWith('/origin/ea/route-preflight', 'POST', {
        model: 'MODEL_PREFLIGHT',
        profile: 'cheap',
        stream: true,
        usesTools: false,
        thinkingEnabled: false
      })
    )

    await user.click(screen.getByRole('button', { name: '已知晓：本次预算不够' }))
    await waitFor(() =>
      expect(requestControl).toHaveBeenCalledWith(
        '/origin/ea/decision-inbox/decision-0123456789abcdef01234567/ack',
        'POST',
        {}
      )
    )
    await user.click(screen.getAllByRole('button', { name: '打开路由配置' }).at(-1)!)
    expect(onNavigate).toHaveBeenCalledWith('routes')
    expect(requestControl.mock.calls.some(([path]) => String(path) === '/origin/ea/route')).toBe(
      false
    )
  })

  it('does not let an older refresh overwrite newer decision data', async () => {
    const user = userEvent.setup()
    let inboxCalls = 0
    let resolveOldInbox: ((value: { ok: true; items: unknown[] }) => void) | undefined
    const oldInbox = new Promise<{ ok: true; items: unknown[] }>((resolve) => {
      resolveOldInbox = resolve
    })
    const decision = (classification: string, suffix: string) => ({
      id: `decision-${suffix.padEnd(24, '0')}`,
      classification,
      status: 'open',
      count: 1,
      lastSeenAt: '2026-08-10T03:00:00.000Z'
    })
    const requestControl = vi.fn<DesktopHost['requestControl']>(async (path) => {
      if (path === '/origin/ea/decision-inbox?limit=50') {
        inboxCalls += 1
        if (inboxCalls === 1) {
          return {
            ok: true,
            status: 200,
            data: { ok: true, items: [decision('budget_rejected', '1')] }
          }
        }
        if (inboxCalls === 2) return { ok: true, status: 200, data: await oldInbox }
        return {
          ok: true,
          status: 200,
          data: { ok: true, items: [decision('all_unavailable', '2')] }
        }
      }
      if (path === '/origin/ea/route-evidence?limit=50') {
        return { ok: true, status: 200, data: { ok: true, evidence: [] } }
      }
      if (path === '/origin/ea/routes') {
        return { ok: true, status: 200, data: { routes: {} } }
      }
      return { ok: false, status: 404, data: {} }
    })
    installHost(requestControl)

    render(<DecisionCenterControlView onNavigate={vi.fn()} />)
    expect(await screen.findByText('本次预算不够')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '刷新' }))
    await user.click(screen.getByRole('button', { name: '刷新' }))
    expect(await screen.findByText('当前没有可用渠道')).toBeInTheDocument()

    resolveOldInbox?.({ ok: true, items: [decision('budget_rejected', '3')] })
    await waitFor(() => expect(screen.queryByText('本次预算不够')).not.toBeInTheDocument())
    expect(screen.getByText('当前没有可用渠道')).toBeInTheDocument()
  })

  it('does not restore an in-flight preflight after its inputs change', async () => {
    const user = userEvent.setup()
    type PreflightResponse = {
      ok: true
      status: 200
      data: Record<string, unknown>
    }
    let resolvePreflight: ((value: PreflightResponse) => void) | undefined
    const pendingPreflight = new Promise<PreflightResponse>((resolve) => {
      resolvePreflight = resolve
    })
    const requestControl = vi.fn<DesktopHost['requestControl']>(async (path, method) => {
      if (path === '/origin/ea/decision-inbox?limit=50') {
        return { ok: true, status: 200, data: { ok: true, items: [] } }
      }
      if (path === '/origin/ea/route-evidence?limit=50') {
        return { ok: true, status: 200, data: { ok: true, evidence: [] } }
      }
      if (path === '/origin/ea/routes') {
        return {
          ok: true,
          status: 200,
          data: { routes: { MODEL_PREFLIGHT: { provider: '规定首选', model: 'm1' } } }
        }
      }
      if (path === '/origin/ea/route-preflight' && method === 'POST') {
        return pendingPreflight
      }
      return { ok: false, status: 404, data: {} }
    })
    installHost(requestControl)

    render(<DecisionCenterControlView onNavigate={vi.fn()} />)
    expect(await screen.findByText('目前正常')).toBeInTheDocument()
    await user.click(screen.getByText('发送前检查（可选）'))
    await waitFor(() => expect(screen.getByLabelText('已配置模型')).toHaveValue('MODEL_PREFLIGHT'))
    await user.selectOptions(screen.getByLabelText('使用用途'), 'cheap')
    await user.click(screen.getByRole('button', { name: '查看预计路线' }))
    expect(screen.getByRole('button', { name: '正在检查…' })).toBeDisabled()

    await user.selectOptions(screen.getByLabelText('使用用途'), 'reliable')
    resolvePreflight?.({
      ok: true,
      status: 200,
      data: {
        ok: true,
        plan: {
          configuredOrder: [{ provider: '规定首选', model: 'm1', actualPriority: 1 }],
          dispatchOrder: [{ provider: '规定首选', model: 'm1', actualPriority: 1 }],
          excluded: [],
          advisoryOrder: []
        }
      }
    })
    await act(async () => {
      await pendingPreflight
    })

    expect(screen.queryByRole('heading', { name: '路由接力单' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '查看预计路线' })).toBeEnabled()
  })

  it('clears a preflight when refreshed route options replace its model', async () => {
    const user = userEvent.setup()
    let currentModel = 'MODEL_OLD'
    const requestControl = vi.fn<DesktopHost['requestControl']>(async (path, method) => {
      if (path === '/origin/ea/decision-inbox?limit=50') {
        return { ok: true, status: 200, data: { ok: true, items: [] } }
      }
      if (path === '/origin/ea/route-evidence?limit=50') {
        return { ok: true, status: 200, data: { ok: true, evidence: [] } }
      }
      if (path === '/origin/ea/routes') {
        return {
          ok: true,
          status: 200,
          data: { routes: { [currentModel]: { provider: '规定渠道', model: 'm1' } } }
        }
      }
      if (path === '/origin/ea/route-preflight' && method === 'POST') {
        return {
          ok: true,
          status: 200,
          data: {
            ok: true,
            plan: {
              configuredOrder: [{ provider: '规定渠道', model: 'm1', actualPriority: 1 }],
              dispatchOrder: [{ provider: '规定渠道', model: 'm1', actualPriority: 1 }],
              excluded: [],
              advisoryOrder: []
            }
          }
        }
      }
      return { ok: false, status: 404, data: {} }
    })
    installHost(requestControl)

    render(<DecisionCenterControlView onNavigate={vi.fn()} />)
    expect(await screen.findByText('目前正常')).toBeInTheDocument()
    await user.click(screen.getByText('发送前检查（可选）'))
    await waitFor(() => expect(screen.getByLabelText('已配置模型')).toHaveValue('MODEL_OLD'))
    await user.click(screen.getByRole('button', { name: '查看预计路线' }))
    expect(await screen.findByRole('heading', { name: '路由接力单' })).toBeInTheDocument()

    currentModel = 'MODEL_NEW'
    await user.click(screen.getByRole('button', { name: '刷新' }))
    await waitFor(() => expect(screen.getByLabelText('已配置模型')).toHaveValue('MODEL_NEW'))
    expect(screen.queryByRole('heading', { name: '路由接力单' })).not.toBeInTheDocument()
  })

  it('keeps observation usable when no configured route can be selected', async () => {
    const user = userEvent.setup()
    const requestControl = vi.fn<DesktopHost['requestControl']>(async (path) => {
      if (path === '/origin/ea/decision-inbox?limit=50') {
        return { ok: true, status: 200, data: { ok: true, items: [] } }
      }
      if (path === '/origin/ea/route-evidence?limit=50') {
        return { ok: true, status: 200, data: { ok: true, evidence: [] } }
      }
      if (path === '/origin/ea/routes') {
        return { ok: true, status: 200, data: { routes: {} } }
      }
      return { ok: false, status: 404, data: {} }
    })
    const onNavigate = vi.fn()
    installHost(requestControl)

    render(<DecisionCenterControlView onNavigate={onNavigate} />)

    expect(await screen.findByText('目前正常')).toBeInTheDocument()
    expect(screen.getByText('还没有真实请求记录')).toBeInTheDocument()
    await user.click(screen.getByText('发送前检查（可选）'))
    expect(screen.getByLabelText('已配置模型')).toBeDisabled()
    expect(screen.getByRole('button', { name: '查看预计路线' })).toBeDisabled()
    await user.click(screen.getAllByRole('button', { name: '打开路由配置' }).at(-1)!)
    expect(onNavigate).toHaveBeenCalledWith('routes')
    expect(requestControl.mock.calls.some(([, method]) => method === 'POST')).toBe(false)
  })
})
