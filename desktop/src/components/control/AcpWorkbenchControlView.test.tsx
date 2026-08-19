// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { DesktopHost } from '@/lib/desktopHost'

import { AcpWorkbenchControlView } from './AcpWorkbenchControlView'

function installHost(
  requestControl: DesktopHost['requestControl'],
  writeClipboard: DesktopHost['writeClipboard'] = async () => undefined
) {
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
    writeClipboard
  }
}

afterEach(() => {
  cleanup()
  delete window.desktopHost
  vi.useRealTimers()
})

describe('native ACP collaboration workbench', () => {
  it('shows agents and unlinked tasks together without inventing a session relation', async () => {
    const onNavigate = vi.fn()
    const requestControl = vi.fn<DesktopHost['requestControl']>(async (path) => {
      if (path === '/origin/hud/snapshot') {
        return {
          ok: true,
          status: 200,
          data: {
            generatedAt: Date.now(),
            runtime: { healthy: true },
            sessions: [
              {
                id: 'session-secret',
                surface: 'devin',
                active: true,
                goal: '处理会话',
                phase: '执行',
                workspace: '/Users/a77/workspace-a',
                latestActivityAt: Date.now(),
                route: { provider: 'cccc', upstreamModel: 'dao-opus-5' },
                todo: { current: '继续工作' }
              }
            ],
            recentRequests: []
          }
        }
      }
      if (path === '/origin/tasks') {
        return {
          ok: true,
          status: 200,
          data: {
            tasks: [
              {
                jobId: 'job-secret',
                taskType: '测试任务',
                phase: '验证',
                status: 'running',
                updatedAt: Date.now(),
                attempts: [{ provider: 'cccc' }, { provider: 'backup' }],
                result: { artifacts: ['/Users/a77/private/result.txt'] }
              }
            ]
          }
        }
      }
      throw new Error(`unexpected path: ${path}`)
    })
    installHost(requestControl)

    render(<AcpWorkbenchControlView onNavigate={onNavigate} />)

    expect(await screen.findByRole('heading', { name: 'Agent 名册' })).toBeInTheDocument()
    expect(screen.getByText('Devin · workspace-a')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '协作链' })).toBeInTheDocument()
    expect(screen.getByText('尚未关联到会话的任务')).toBeInTheDocument()
    expect(screen.getByText('尝试 2 次 · 产物 1 项')).toBeInTheDocument()
    expect(screen.queryByText('session-secret')).not.toBeInTheDocument()
    expect(screen.queryByText('job-secret')).not.toBeInTheDocument()
    expect(screen.queryByText('/Users/a77/private/result.txt')).not.toBeInTheDocument()
    expect(requestControl).toHaveBeenCalledWith('/origin/hud/snapshot', 'GET', undefined)
    expect(requestControl).toHaveBeenCalledWith('/origin/tasks', 'GET', undefined)

    await userEvent.click(screen.getByRole('button', { name: '打开任务与产物' }))
    expect(onNavigate).toHaveBeenCalledWith('tasks')
  })

  it('keeps session observation visible when only task details fail', async () => {
    installHost(async (path) => {
      if (path === '/origin/tasks') throw new Error('tasks offline')
      return {
        ok: true,
        status: 200,
        data: {
          generatedAt: 1,
          sessions: [
            {
              surface: 'codex',
              active: true,
              workspace: 'workspace-safe',
              latestActivityAt: Date.now(),
              goal: '继续会话观测'
            }
          ]
        }
      }
    })

    render(<AcpWorkbenchControlView />)

    expect(await screen.findByText('Codex · workspace-safe')).toBeInTheDocument()
    expect(screen.getByText('任务详情暂不可用，会话观测仍正常。')).toBeInTheDocument()
  })

  it('keeps the collaboration chain to the five-minute live window', async () => {
    const now = Date.now()
    installHost(async (path) => ({
      ok: true,
      status: 200,
      data:
        path === '/origin/tasks'
          ? {
              tasks: [
                {
                  jobId: 'old-turn',
                  taskType: 'codex-turn',
                  status: 'succeeded',
                  updatedAt: now - 6 * 60 * 1_000
                },
                {
                  jobId: 'live-turn',
                  taskType: 'codex-turn',
                  status: 'running',
                  updatedAt: now
                }
              ]
            }
          : {
              generatedAt: now,
              sessions: [
                {
                  id: 'old-session',
                  surface: 'codex',
                  active: true,
                  latestActivityAt: now - 6 * 60 * 1_000,
                  goal: '旧会话'
                },
                {
                  id: 'live-session',
                  surface: 'devin',
                  active: true,
                  latestActivityAt: now,
                  goal: '当前会话',
                  workspace: '/Users/demo/live'
                }
              ]
            }
    }))

    render(<AcpWorkbenchControlView />)

    await screen.findByRole('heading', { name: '协作链' })
    const chain = screen.getByText('协作链').closest('section')
    expect(chain).not.toBeNull()
    expect(await within(chain as HTMLElement).findByText('当前会话')).toBeInTheDocument()
    expect(within(chain as HTMLElement).queryByText('旧会话')).not.toBeInTheDocument()
    expect(
      await within(chain as HTMLElement).findByText('Codex turn（仅运行事实）')
    ).toBeInTheDocument()
    expect(within(chain as HTMLElement).queryByText('当前没有独立任务记录')).not.toBeInTheDocument()
  })

  it('ignores an older refresh that resolves after a newer polling result', async () => {
    vi.useFakeTimers()
    let hudCalls = 0
    let resolveOlder: ((value: unknown) => void) | undefined
    const older = new Promise<unknown>((resolve) => {
      resolveOlder = resolve
    })
    installHost(async (path) => {
      if (path === '/origin/tasks') {
        return { ok: true, status: 200, data: { tasks: [] } }
      }
      hudCalls += 1
      if (hudCalls === 2) {
        return { ok: true, status: 200, data: await older }
      }
      const workspace = hudCalls >= 3 ? 'newer-workspace' : 'initial-workspace'
      return {
        ok: true,
        status: 200,
        data: {
          generatedAt: hudCalls,
          sessions: [{ surface: 'acp', workspace, goal: `会话 ${workspace}` }]
        }
      }
    })

    render(<AcpWorkbenchControlView />)
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(screen.getAllByText('ACP · initial-workspace').length).toBeGreaterThan(0)

    fireEvent.click(screen.getByRole('button', { name: '刷新' }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000)
    })
    expect(screen.getAllByText('ACP · newer-workspace').length).toBeGreaterThan(0)

    await act(async () => {
      resolveOlder?.({
        generatedAt: 2,
        sessions: [{ surface: 'acp', workspace: 'older-workspace', goal: '旧会话' }]
      })
      await Promise.resolve()
    })
    expect(screen.queryAllByText('ACP · older-workspace')).toHaveLength(0)
    expect(screen.getAllByText('ACP · newer-workspace').length).toBeGreaterThan(0)
  })

  it('renders session route facts and activity, with source filtering', async () => {
    const user = userEvent.setup()
    const requestControl = vi.fn(async () => ({
      ok: true,
      status: 200,
      data: {
        generatedAt: Date.now(),
        runtime: { healthy: true, mode: 'desktop', port: 8955, connection: 'live' },
        sessions: [
          {
            id: 'acp-session-1',
            surface: 'acp',
            active: true,
            lifecycle: 'running',
            goal: '准备协作交接',
            phase: '执行工具',
            workspace: '/Users/demo/dao',
            latestActivityAt: Date.now(),
            route: {
              modelUid: 'dao-opus-5',
              provider: 'bridge',
              upstreamModel: 'claude-opus',
              provisional: false
            },
            telemetry: {
              ttftMs: 420,
              durationMs: 2_100,
              modelPath: 'routed',
              loopSource: 'acp',
              reasoningTokens: 80,
              compactions: 1
            },
            cache: { observed: true, calls: 3, cached: 1_200, cacheWrite: 300, hitRate: 40 },
            verification: { status: 'passed', blocking: false },
            failures: { maxConsecutive: 0, sameCallStreak: 0, lastToolOk: true },
            todo: { completed: 1, total: 3, current: '整理产物' }
          },
          {
            id: 'codex-session-1',
            surface: 'codex',
            active: false,
            goal: 'Codex 任务',
            workspace: '/Users/demo/dao'
          },
          {
            id: 'blocked-session-1',
            surface: 'acp',
            active: true,
            lifecycle: 'running',
            goal: '需要人工接手',
            phase: '验证',
            workspace: '/Users/demo/dao',
            latestActivityAt: Date.now() - 1_000,
            verification: { status: 'pending', blocking: true }
          }
        ],
        providers: [
          {
            id: 'bridge',
            latency: {
              overall: { p50TtftMs: 380, p95TtftMs: 720 },
              cache: { hit: { p95TtftMs: 180 }, miss: { p95TtftMs: 420 } }
            }
          }
        ],
        recentRequests: [
          {
            id: 'req-1',
            at: Date.now(),
            source: 'acp',
            provider: 'bridge',
            model: 'claude-opus',
            success: true,
            ttftMs: 420,
            durationMs: 2_100,
            cached: 1_200
          }
        ]
      }
    }))
    const writeClipboard = vi.fn(async () => undefined)
    installHost(requestControl, writeClipboard)

    render(<AcpWorkbenchControlView />)

    expect(await screen.findByRole('heading', { name: 'ACP 协作' })).toBeInTheDocument()
    expect(
      await screen.findByRole('heading', { name: '准备协作交接', level: 3 })
    ).toBeInTheDocument()
    expect(screen.getAllByText('bridge').length).toBeGreaterThan(0)
    expect(screen.getAllByText('claude-opus').length).toBeGreaterThan(0)
    const channelMatrix = screen.getByRole('region', { name: '渠道健康矩阵' })
    expect(within(channelMatrix).getByText('bridge')).toBeInTheDocument()
    expect(within(channelMatrix).getByText('720 ms')).toBeInTheDocument()
    expect(screen.getByRole('region', { name: '语义活动流' })).toBeInTheDocument()
    const diagnostics = screen.getByRole('region', { name: '会话诊断' })
    expect(diagnostics).toBeInTheDocument()
    expect(screen.getByRole('region', { name: '人工接手队列' })).toBeInTheDocument()
    expect(within(diagnostics).getByText('验证')).toBeInTheDocument()
    expect(within(diagnostics).getByText('失败信号')).toBeInTheDocument()
    expect(within(diagnostics).getByText('推理 Token')).toBeInTheDocument()
    expect(within(diagnostics).getByText('渠道 TTFT P95')).toBeInTheDocument()
    expect(within(diagnostics).getByText('缓存未命中 P95')).toBeInTheDocument()
    expect(screen.getAllByText('720 ms')).toHaveLength(2)
    await user.click(screen.getByRole('button', { name: '复制交接包' }))
    expect(writeClipboard).toHaveBeenCalledWith(expect.stringContaining('# FOMO ACP 会话交接'))

    await user.click(screen.getByRole('button', { name: '查看会话：需要人工接手' }))
    expect(
      within(screen.getByRole('toolbar', { name: '会话来源筛选' })).getByRole('button', {
        name: '全部'
      })
    ).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('heading', { name: '需要人工接手', level: 3 })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'CODEX' }))
    expect(
      screen.queryByRole('heading', { name: '准备协作交接', level: 3 })
    ).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Codex 任务', level: 3 })).toBeInTheDocument()
  })

  it('shows cache hit KPI from request samples when available', async () => {
    installHost(async (path) => {
      if (path === '/origin/tasks') {
        return { ok: true, status: 200, data: { tasks: [] } }
      }
      return {
        ok: true,
        status: 200,
        data: {
          generatedAt: Date.now(),
          runtime: { healthy: true },
          sessions: [],
          recentRequests: [
            { id: 'r1', at: Date.now(), cacheStatus: 'hit', cached: 59968 },
            { id: 'r2', at: Date.now(), cacheStatus: 'hit', cached: 59904 },
            { id: 'r3', at: Date.now(), cacheStatus: 'miss', cached: 0 }
          ]
        }
      }
    })

    render(<AcpWorkbenchControlView />)

    expect(await screen.findByText('缓存命中')).toBeInTheDocument()
    expect(screen.getByText('66.7%')).toBeInTheDocument()
    expect(screen.getByText('2/3 次请求命中')).toBeInTheDocument()
  })

  it('falls back to session cache hit rate when no request samples exist', async () => {
    installHost(async (path) => {
      if (path === '/origin/tasks') {
        return { ok: true, status: 200, data: { tasks: [] } }
      }
      return {
        ok: true,
        status: 200,
        data: {
          generatedAt: Date.now(),
          runtime: { healthy: true },
          sessions: [
            {
              id: 's1',
              surface: 'devin',
              active: true,
              latestActivityAt: Date.now(),
              goal: '工作会话',
              cache: { observed: true, calls: 12, cached: 499776, cacheWrite: 0, hitRate: 87.7 }
            }
          ],
          recentRequests: []
        }
      }
    })

    render(<AcpWorkbenchControlView />)

    expect(await screen.findByText('缓存命中')).toBeInTheDocument()
    expect(screen.getAllByText('87.7%').length).toBeGreaterThan(0)
    expect(screen.getByText('12 次会话缓存')).toBeInTheDocument()
  })

  it('shows placeholder when no cache observation exists', async () => {
    installHost(async (path) => {
      if (path === '/origin/tasks') {
        return { ok: true, status: 200, data: { tasks: [] } }
      }
      return {
        ok: true,
        status: 200,
        data: {
          generatedAt: Date.now(),
          runtime: { healthy: true },
          sessions: [],
          recentRequests: []
        }
      }
    })

    render(<AcpWorkbenchControlView />)

    expect(await screen.findByText('缓存命中')).toBeInTheDocument()
    expect(screen.getByText('—')).toBeInTheDocument()
    expect(screen.getByText('等待缓存观测样本')).toBeInTheDocument()
  })

  it('renders an explicit empty state for an empty HUD snapshot', async () => {
    installHost(async () => ({
      ok: true,
      status: 200,
      data: {
        generatedAt: Date.now(),
        runtime: { healthy: true },
        sessions: [],
        recentRequests: []
      }
    }))

    render(<AcpWorkbenchControlView />)

    expect(await screen.findByText('等待第一个会话事件')).toBeInTheDocument()
  })
})
