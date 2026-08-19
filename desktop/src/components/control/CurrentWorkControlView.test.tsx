// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { DaoControlResponse, DesktopHost } from '@/lib/desktopHost'

import { CurrentWorkControlView } from './CurrentWorkControlView'

function installHost(
  requestControl: DesktopHost['requestControl'],
  overrides: Partial<DesktopHost> = {}
) {
  window.desktopHost = {
    getRuntimeStatus: async () => ({
      healthy: true,
      running: true,
      port: 8955,
      url: '',
      profile: 'desktop',
      imported: { config: false, revproxy: false },
      error: null
    }),
    retryRuntime: async () => ({
      healthy: true,
      running: true,
      port: 8955,
      url: '',
      profile: 'desktop',
      imported: { config: false, revproxy: false },
      error: null
    }),
    getDashboardSnapshot: async () =>
      ({}) as Awaited<ReturnType<DesktopHost['getDashboardSnapshot']>>,
    openExternal: async () => undefined,
    openConfig: async () => undefined,
    openControlConsole: async () => undefined,
    requestControl,
    saveHandoff: async () => ({ ok: true }),
    writeClipboard: async () => undefined,
    ...overrides
  }
}

afterEach(() => {
  cleanup()
  delete window.desktopHost
})

describe('current work desk', () => {
  it('combines session, request, task, Taskboard, and approval facts into one activity feed', async () => {
    const now = Date.now()
    const requestControl = vi.fn<DesktopHost['requestControl']>(async (path) => {
      if (path === '/origin/hud/snapshot') {
        return {
          ok: true,
          status: 200,
          data: {
            runtime: { healthy: true, port: 8955, connection: 'loopback' },
            sessions: [
              {
                id: 'private-feed-session',
                surface: 'devin',
                active: true,
                lifecycle: 'running',
                goal: '验证语义工作台',
                phase: '执行中',
                latestActivityAt: now
              }
            ],
            recentRequests: [
              {
                id: 'private-feed-request',
                at: now - 100,
                source: 'devin',
                provider: 'cccc',
                model: 'gpt-5.6',
                status: 'succeeded',
                success: true,
                cacheStatus: 'hit'
              }
            ]
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
                jobId: 'private-feed-job',
                source: 'codex',
                commandSummary: '构建桌面应用',
                status: 'running',
                phase: '构建中',
                updatedAt: now - 200
              }
            ]
          }
        }
      }
      if (path === '/origin/ea/decision-inbox?limit=50') {
        return {
          ok: true,
          status: 200,
          data: {
            items: [
              {
                id: 'decision-0123456789abcdef01234567',
                classification: 'repeated_fallback',
                status: 'open',
                count: 2,
                lastSeenAt: new Date(now - 50).toISOString()
              }
            ]
          }
        }
      }
      throw new Error(`unexpected ${path}`)
    })
    installHost(requestControl, {
      getTaskboardSnapshot: async () => ({
        state: 'connected',
        writable: true,
        message: '已连接本地 Taskboard。',
        items: [
          {
            identifier: 'DAOFLOW-7',
            title: 'Buzz 语义层',
            status: 'in_progress',
            priority: 'high',
            updatedAt: now - 300
          }
        ]
      })
    })

    render(<CurrentWorkControlView onOpenItem={() => undefined} onNavigate={() => undefined} />)

    expect(await screen.findByRole('region', { name: '刚刚发生' })).toBeInTheDocument()
    expect(screen.getByText('模型请求 经过 cccc · gpt-5.6')).toBeInTheDocument()
    expect(screen.getByText('Taskboard 跟踪 DAOFLOW-7 · Buzz 语义层')).toBeInTheDocument()
    expect(screen.getByText('路由观察 请求确认 首选渠道没有接住请求')).toBeInTheDocument()
    expect(requestControl).toHaveBeenCalledWith('/origin/hud/snapshot', 'GET', undefined)
    expect(requestControl).toHaveBeenCalledWith('/origin/tasks', 'GET', undefined)
    expect(requestControl).toHaveBeenCalledWith(
      '/origin/ea/decision-inbox?limit=50',
      'GET',
      undefined
    )
    expect(requestControl.mock.calls.every(([, method]) => method === 'GET')).toBe(true)
    expect(document.body.textContent).not.toMatch(
      /private-feed-session|private-feed-request|private-feed-job/
    )
  })

  it('keeps live work visible when the decision source is unavailable', async () => {
    const requestControl = vi.fn<DesktopHost['requestControl']>(async (path) => {
      if (path === '/origin/hud/snapshot') {
        return {
          ok: true,
          status: 200,
          data: {
            sessions: [
              {
                id: 'private-partial-session',
                surface: 'devin',
                active: true,
                goal: '继续验证工作台',
                phase: '执行中',
                latestActivityAt: Date.now()
              }
            ]
          }
        }
      }
      if (path === '/origin/tasks') return { ok: true, status: 200, data: { tasks: [] } }
      if (path === '/origin/ea/decision-inbox?limit=50') throw new Error('decision unavailable')
      throw new Error(`unexpected ${path}`)
    })
    installHost(requestControl)

    render(<CurrentWorkControlView onOpenItem={() => undefined} />)

    expect(await screen.findByText('继续验证工作台')).toBeInTheDocument()
    expect(screen.getByRole('region', { name: '刚刚发生' })).toBeInTheDocument()
    expect(screen.getByText('待确认事项暂时无法读取，其他工作事实仍可查看。')).toBeInTheDocument()
    expect(document.body.textContent).not.toContain('private-partial-session')
  })

  it('shows a safe live pulse on work cards and selected details', async () => {
    const requestControl = vi.fn<DesktopHost['requestControl']>(async (path) => {
      if (path === '/origin/hud/snapshot') {
        return {
          ok: true,
          status: 200,
          data: {
            sessions: [
              {
                id: 'private-pulse-session',
                surface: 'devin',
                active: true,
                goal: '修复工作台',
                latestActivityAt: Date.now(),
                route: {
                  modelUid: 'swe-1-6-slow',
                  provider: 'dp',
                  upstreamModel: 'deepseek-v4-flash',
                  provisional: false
                },
                todo: { completed: 1, total: 3, current: 'todo-2: 整理验证结果' },
                failures: { lastToolOk: true }
              }
            ]
          }
        }
      }
      if (path === '/origin/tasks') return { ok: true, status: 200, data: { tasks: [] } }
      throw new Error(`unexpected ${path}`)
    })
    installHost(requestControl)
    render(<CurrentWorkControlView onOpenItem={() => undefined} />)

    expect(await screen.findByText('现在在做：整理验证结果')).toBeInTheDocument()
    expect(screen.getByText('1 / 3 项完成 · 最近工具成功')).toBeInTheDocument()
    expect(screen.getByText('正在使用的模型：deepseek-v4-flash')).toBeInTheDocument()
    expect(screen.getByText('渠道 dp · 路由名 swe-1-6-slow')).toBeInTheDocument()
    expect(screen.queryByText('todo-2')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /修复工作台.*查看协作会话/ }))
    expect(await screen.findByText('工作脉冲')).toBeInTheDocument()
    expect(screen.getByText('最近结果：最近工具成功')).toBeInTheDocument()
  })

  it('loads HUD then tasks, degrades safely, and only uses GET', async () => {
    const requestControl = vi.fn<DesktopHost['requestControl']>(async (path) => {
      if (path === '/origin/hud/snapshot')
        return {
          ok: true,
          status: 200,
          data: {
            sessions: [
              {
                id: 'session-1',
                surface: 'codex',
                active: true,
                goal: 'Review code',
                phase: '验证',
                latestActivityAt: Date.now()
              }
            ],
            tasks: [
              {
                jobId: 'task-1',
                source: 'codex',
                taskType: 'build',
                status: 'running',
                phase: '执行',
                updatedAt: Date.now()
              }
            ]
          }
        }
      throw new Error('unavailable')
    })
    installHost(requestControl)
    const onOpenItem = vi.fn()
    render(<CurrentWorkControlView onOpenItem={onOpenItem} />)
    expect(await screen.findByRole('heading', { name: '当前工作' })).toBeInTheDocument()
    expect(await screen.findByText('任务详情接口暂不可用，当前显示 HUD 摘要。')).toBeInTheDocument()
    expect(requestControl).toHaveBeenCalledWith('/origin/hud/snapshot', 'GET', undefined)
    expect(requestControl).toHaveBeenCalledWith('/origin/tasks', 'GET', undefined)
    expect(requestControl.mock.calls.every(([, method]) => method === 'GET')).toBe(true)
    const sessionButton = screen.getByRole('button', { name: /Review code.*查看协作会话/ })
    fireEvent.click(sessionButton)
    expect(onOpenItem).not.toHaveBeenCalled()
    expect(screen.getByText('可选干预')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '打开协作会话' }))
    expect(onOpenItem).toHaveBeenCalledWith(
      expect.objectContaining({ target: { view: 'collaboration', id: 'session-1' } })
    )
    expect(screen.queryByText('session-1')).not.toBeInTheDocument()
  })

  it('keeps a task detail on this desk until explicit navigation', async () => {
    const requestControl = vi.fn<DesktopHost['requestControl']>(async (path) => {
      if (path === '/origin/hud/snapshot') {
        return {
          ok: true,
          status: 200,
          data: {
            sessions: [],
            tasks: [
              {
                jobId: 'task-1',
                source: 'codex',
                taskType: 'build',
                commandSummary: '构建桌面应用',
                status: 'failed',
                phase: '失败',
                updatedAt: Date.now(),
                result: {
                  status: 'succeeded',
                  exitCode: 0,
                  stdoutSummary: '构建成功',
                  artifacts: [{ ref: 'dist/app.zip', kind: '压缩包' }]
                }
              }
            ]
          }
        }
      }
      if (path === '/origin/tasks') throw new Error('not needed')
      if (path === '/origin/ea/routing-decisions?profile=balanced&limit=20') {
        return {
          ok: true,
          status: 200,
          data: {
            decisions: [
              {
                profile: 'coding',
                candidates: [{ provider: '本地', model: 'coder', advisoryScore: 0.9 }]
              }
            ]
          }
        }
      }
      if (path === '/origin/ea/handoff.md') {
        return { ok: true, status: 200, data: '# handoff' }
      }
      throw new Error('not needed')
    })
    installHost(requestControl)
    const onOpenItem = vi.fn()
    render(<CurrentWorkControlView onOpenItem={onOpenItem} />)

    const taskButton = await screen.findByRole('button', { name: /构建桌面应用.*查看任务详情/ })
    fireEvent.click(taskButton)
    expect(onOpenItem).not.toHaveBeenCalled()
    expect(await screen.findByText('任务产物与终端事实')).toBeInTheDocument()
    expect(screen.getByText('完成摘要：构建成功')).toBeInTheDocument()
    expect(await screen.findByText('建议视角：编码（接口返回）')).toBeInTheDocument()
    expect(screen.getByText('本地 · coder')).toBeInTheDocument()
    expect(
      screen.getByText('任务产物与终端事实').compareDocumentPosition(screen.getByText('可选干预')) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    expect(requestControl).toHaveBeenCalledWith(
      '/origin/ea/routing-decisions?profile=balanced&limit=20',
      'GET',
      undefined
    )
    expect(requestControl).toHaveBeenCalledWith('/origin/ea/handoff.md', 'GET', undefined)
    expect(requestControl.mock.calls.every(([, method]) => method === 'GET')).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: '打开任务进度' }))
    expect(onOpenItem).toHaveBeenCalledWith(
      expect.objectContaining({ target: { view: 'tasks', id: 'task-1' } })
    )
  })

  it('renders section empty states', async () => {
    installHost(
      vi.fn<DesktopHost['requestControl']>(async () => ({
        ok: true,
        status: 200,
        data: { sessions: [], tasks: [] }
      }))
    )
    render(<CurrentWorkControlView onOpenItem={() => undefined} />)
    await waitFor(() => expect(screen.getByText('目前没有需要你处理的异常。')).toBeInTheDocument())
    expect(screen.getByText('目前没有 Agent 正在运行。')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: '最近完成' })).not.toBeInTheDocument()
  })

  it('explains successful observation when terminal work has left the live desk', async () => {
    const requestControl = vi.fn<DesktopHost['requestControl']>(async (path) => {
      if (path === '/origin/hud/snapshot') {
        return {
          ok: true,
          status: 200,
          data: {
            runtime: { healthy: true, port: 8955, mode: 'invert', connection: 'loopback' },
            sessions: [
              {
                id: 'private-stopped-session',
                surface: 'devin',
                lifecycle: 'stopped',
                active: false,
                goal: '已经停止的会话',
                latestActivityAt: Date.now()
              }
            ]
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
                jobId: 'private-finished-task',
                source: 'codex',
                taskType: 'build',
                commandSummary: '已经完成的长任务',
                status: 'succeeded',
                updatedAt: Date.now()
              }
            ]
          }
        }
      }
      throw new Error(`unexpected ${path}`)
    })
    installHost(requestControl)
    render(<CurrentWorkControlView onOpenItem={() => undefined} onNavigate={() => undefined} />)

    expect(await screen.findByText('数据源 本机 :8955')).toBeInTheDocument()
    expect(screen.getByText('观测到 1 个会话')).toBeInTheDocument()
    expect(screen.getByText('1 个长任务')).toBeInTheDocument()
    expect(screen.getByText('已退出实时桌 2')).toBeInTheDocument()
    expect(
      screen.getByText('观测正常；当前没有 Agent 正在运行。已结束内容可在历史页查看。')
    ).toBeInTheDocument()
    expect(screen.queryByText('已经停止的会话')).not.toBeInTheDocument()
    expect(screen.queryByText('已经完成的长任务')).not.toBeInTheDocument()
    expect(screen.queryByText('private-stopped-session')).not.toBeInTheDocument()
    expect(screen.queryByText('private-finished-task')).not.toBeInTheDocument()
  })

  it('retires a quiet active session after five minutes without activity', async () => {
    const requestControl = vi.fn<DesktopHost['requestControl']>(async (path) => {
      if (path === '/origin/hud/snapshot') {
        return {
          ok: true,
          status: 200,
          data: {
            runtime: { healthy: true, port: 8955 },
            sessions: [
              {
                id: 'quiet-session-token',
                surface: 'devin',
                lifecycle: 'active',
                active: true,
                requestInFlight: true,
                goal: '五分钟无活动的会话',
                latestActivityAt: Date.now() - 5 * 60_000 - 1
              }
            ]
          }
        }
      }
      if (path === '/origin/tasks') return { ok: true, status: 200, data: { tasks: [] } }
      throw new Error(`unexpected ${path}`)
    })
    installHost(requestControl)
    render(<CurrentWorkControlView onOpenItem={() => undefined} onNavigate={() => undefined} />)

    expect(await screen.findByText('数据源 本机 :8955')).toBeInTheDocument()
    expect(screen.getByText('观测到 1 个会话')).toBeInTheDocument()
    expect(screen.getByText('已退出实时桌 1')).toBeInTheDocument()
    expect(screen.queryByText('五分钟无活动的会话')).not.toBeInTheDocument()
  })

  it('retires task attention facts after five minutes on the live desk', async () => {
    const requestControl = vi.fn<DesktopHost['requestControl']>(async (path) => {
      if (path === '/origin/hud/snapshot') {
        return { ok: true, status: 200, data: { runtime: { port: 8955 }, sessions: [] } }
      }
      if (path === '/origin/tasks') {
        return {
          ok: true,
          status: 200,
          data: {
            tasks: [
              {
                jobId: 'old-failure-token',
                source: 'codex',
                status: 'failed',
                updatedAt: Date.now() - 5 * 60_000 - 1
              },
              {
                jobId: 'quiet-queued-token',
                source: 'codex',
                status: 'queued',
                updatedAt: Date.now() - 5 * 60_000 - 1
              },
              {
                jobId: 'recent-failure-token',
                source: 'codex',
                status: 'failed',
                updatedAt: Date.now()
              }
            ]
          }
        }
      }
      throw new Error(`unexpected ${path}`)
    })
    installHost(requestControl)
    render(<CurrentWorkControlView onOpenItem={() => undefined} />)

    expect(await screen.findByText('Codex 长任务失败')).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: /Codex 长任务失败.*查看任务详情/ })
    ).toBeInTheDocument()
    expect(screen.getByText('待处理 1')).toBeInTheDocument()
    expect(screen.getByText('运行中 0')).toBeInTheDocument()
    expect(screen.getByText('已退出实时桌 2')).toBeInTheDocument()
    expect(screen.queryByText('old-failure-token')).not.toBeInTheDocument()
    expect(screen.queryByText('quiet-queued-token')).not.toBeInTheDocument()
  })

  it('shows observed counts next to live work without exposing navigation tokens', async () => {
    const requestControl = vi.fn<DesktopHost['requestControl']>(async (path) => {
      if (path === '/origin/hud/snapshot') {
        return {
          ok: true,
          status: 200,
          data: {
            runtime: { healthy: true, port: 54500, mode: 'invert', connection: 'loopback' },
            sessions: [
              {
                id: 'private-live-session',
                surface: 'codex',
                lifecycle: 'active',
                active: true,
                goal: '正在修复观测',
                latestActivityAt: Date.now()
              }
            ]
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
                jobId: 'private-live-task',
                source: 'codex',
                taskType: 'test',
                commandSummary: '正在跑回归',
                status: 'running',
                updatedAt: Date.now()
              }
            ]
          }
        }
      }
      throw new Error(`unexpected ${path}`)
    })
    installHost(requestControl)
    render(<CurrentWorkControlView onOpenItem={() => undefined} />)

    expect(await screen.findByText('数据源 本机 :54500')).toBeInTheDocument()
    expect(screen.getByText('观测到 1 个会话')).toBeInTheDocument()
    expect(screen.getByText('1 个长任务')).toBeInTheDocument()
    expect(screen.getByText('已退出实时桌 0')).toBeInTheDocument()
    expect(screen.getByText('运行中 2')).toBeInTheDocument()
    expect(screen.queryByText('private-live-session')).not.toBeInTheDocument()
    expect(screen.queryByText('private-live-task')).not.toBeInTheDocument()
  })

  it('prioritizes a later HUD error over a stale fallback notice', async () => {
    let hudFails = false
    const requestControl = vi.fn<DesktopHost['requestControl']>(async (path) => {
      if (path === '/origin/hud/snapshot' && hudFails) throw new Error('hud unavailable')
      if (path === '/origin/hud/snapshot')
        return { ok: true, status: 200, data: { sessions: [], tasks: [] } }
      throw new Error('tasks unavailable')
    })
    installHost(requestControl)
    render(<CurrentWorkControlView onOpenItem={() => undefined} />)
    expect(await screen.findByText('任务详情接口暂不可用，当前显示 HUD 摘要。')).toBeInTheDocument()

    hudFails = true
    fireEvent.click(screen.getByRole('button', { name: '刷新' }))
    expect(await screen.findByText('工作摘要暂时无法读取，稍后将自动重试。')).toBeInTheDocument()
    expect(screen.queryByText('任务详情接口暂不可用，当前显示 HUD 摘要。')).not.toBeInTheDocument()
  })

  it('retires a selected work capsule after five minutes even while HUD is unavailable', async () => {
    vi.useFakeTimers()
    const startedAt = 10_000_000
    vi.setSystemTime(startedAt)
    let hudFails = false
    const requestControl = vi.fn<DesktopHost['requestControl']>(async (path) => {
      if (path === '/origin/hud/snapshot') {
        if (hudFails) throw new Error('hud unavailable')
        return {
          ok: true,
          status: 200,
          data: {
            sessions: [
              {
                id: 'private-expiring-session',
                surface: 'devin',
                lifecycle: 'active',
                active: true,
                goal: '等待观测源恢复',
                latestActivityAt: startedAt
              }
            ]
          }
        }
      }
      if (path === '/origin/tasks') return { ok: true, status: 200, data: { tasks: [] } }
      if (path === '/origin/ea/decision-inbox?limit=50') {
        return { ok: true, status: 200, data: { items: [] } }
      }
      if (path.startsWith('/origin/ea/')) return { ok: true, status: 200, data: {} }
      throw new Error(`unexpected ${path}`)
    })
    installHost(requestControl)

    try {
      render(<CurrentWorkControlView onOpenItem={() => undefined} />)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })
      fireEvent.click(screen.getByRole('button', { name: /等待观测源恢复.*查看协作会话/ }))
      expect(screen.getByRole('region', { name: '工作舱' })).toBeInTheDocument()

      hudFails = true
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5 * 60_000 + 1_001)
      })

      expect(screen.queryByText('等待观测源恢复')).not.toBeInTheDocument()
      expect(screen.queryByRole('region', { name: '工作舱' })).not.toBeInTheDocument()
      expect(screen.getByText('已退出实时桌 1')).toBeInTheDocument()
      expect(screen.getByText('工作摘要暂时无法读取，稍后将自动重试。')).toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not let an older overlapping refresh overwrite newer data', async () => {
    let resolveOlderTasks: ((value: DaoControlResponse) => void) | undefined
    let hudCall = 0
    let taskCall = 0
    const requestControl = vi.fn<DesktopHost['requestControl']>(async (path) => {
      if (path === '/origin/hud/snapshot') {
        hudCall += 1
        return hudCall < 3
          ? {
              ok: true,
              status: 200,
              data: {
                sessions: [
                  {
                    id: 'old-session',
                    surface: 'codex',
                    active: true,
                    goal: 'Old work',
                    phase: '旧',
                    latestActivityAt: Date.now()
                  }
                ]
              }
            }
          : {
              ok: true,
              status: 200,
              data: {
                sessions: [
                  {
                    id: 'new-session',
                    surface: 'codex',
                    active: true,
                    goal: 'New work',
                    phase: '执行',
                    latestActivityAt: Date.now()
                  }
                ]
              }
            }
      }
      if (path === '/origin/tasks') {
        taskCall += 1
        if (taskCall === 2)
          return await new Promise((resolve) => {
            resolveOlderTasks = resolve
          })
        return { ok: true, status: 200, data: { tasks: [] } }
      }
      if (path === '/origin/ea/decision-inbox?limit=50') {
        return { ok: true, status: 200, data: { items: [] } }
      }
      throw new Error(`unexpected ${path}`)
    })
    installHost(requestControl)
    render(<CurrentWorkControlView onOpenItem={() => undefined} />)
    expect(await screen.findByText('Old work')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '刷新' }))
    fireEvent.click(screen.getByRole('button', { name: '刷新' }))
    expect(await screen.findByText('New work')).toBeInTheDocument()
    resolveOlderTasks?.({ ok: true, status: 200, data: { tasks: [] } })
    await waitFor(() => expect(screen.queryByText('Old work')).not.toBeInTheDocument())
    expect(screen.getByText('New work')).toBeInTheDocument()
  })

  it('updates an open work capsule when the same live work reports newer route facts', async () => {
    let hudCall = 0
    const requestControl = vi.fn<DesktopHost['requestControl']>(async (path) => {
      if (path === '/origin/hud/snapshot') {
        hudCall += 1
        const latest = hudCall > 1
        return {
          ok: true,
          status: 200,
          data: {
            sessions: [
              {
                id: 'private-refresh-session',
                surface: 'devin',
                active: true,
                goal: '同步工作舱事实',
                phase: latest ? '验证新模型' : '使用旧模型',
                latestActivityAt: Date.now(),
                route: {
                  provider: latest ? 'new-channel' : 'old-channel',
                  upstreamModel: latest ? 'new-model' : 'old-model',
                  modelUid: latest ? 'new-route' : 'old-route',
                  provisional: false
                }
              }
            ]
          }
        }
      }
      if (path === '/origin/tasks') return { ok: true, status: 200, data: { tasks: [] } }
      if (path === '/origin/ea/decision-inbox?limit=50') {
        return { ok: true, status: 200, data: { items: [] } }
      }
      if (path.startsWith('/origin/ea/routing-decisions')) {
        return { ok: true, status: 200, data: { decisions: [] } }
      }
      if (path === '/origin/ea/handoff.md') return { ok: true, status: 200, data: '' }
      throw new Error(`unexpected ${path}`)
    })
    installHost(requestControl)
    render(<CurrentWorkControlView onOpenItem={() => undefined} />)

    fireEvent.click(await screen.findByRole('button', { name: /同步工作舱事实.*查看协作会话/ }))
    expect(screen.getByText('上游渠道 old-channel · 上游模型 old-model')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '刷新' }))

    expect(await screen.findByText('上游渠道 new-channel · 上游模型 new-model')).toBeInTheDocument()
    expect(screen.getByText('路由配置名 new-route')).toBeInTheDocument()
    expect(screen.queryByText('上游渠道 old-channel · 上游模型 old-model')).not.toBeInTheDocument()
  })

  it('does not let an older selected item overwrite newer advisory data', async () => {
    const tasks = [
      {
        jobId: 'task-old',
        source: 'codex',
        taskType: 'build',
        commandSummary: '旧任务',
        status: 'running',
        updatedAt: Date.now() - 1_000
      },
      {
        jobId: 'task-new',
        source: 'codex',
        taskType: 'build',
        commandSummary: '新任务',
        status: 'running',
        updatedAt: Date.now()
      }
    ]
    let resolveOld: ((value: DaoControlResponse) => void) | undefined
    let routingCall = 0
    const requestControl = vi.fn<DesktopHost['requestControl']>(async (path) => {
      if (path === '/origin/hud/snapshot') {
        return { ok: true, status: 200, data: { sessions: [], tasks } }
      }
      if (path === '/origin/tasks') return { ok: true, status: 200, data: { tasks } }
      if (path === '/origin/ea/handoff.md') {
        return { ok: true, status: 200, data: '# handoff' }
      }
      if (path === '/origin/ea/routing-decisions?profile=balanced&limit=20') {
        routingCall += 1
        if (routingCall === 1) {
          return await new Promise((resolve) => {
            resolveOld = resolve
          })
        }
        return {
          ok: true,
          status: 200,
          data: {
            decisions: [
              { profile: 'fast', candidates: [{ provider: '新渠道', model: 'new-model' }] }
            ]
          }
        }
      }
      throw new Error(`unexpected ${path}`)
    })
    installHost(requestControl)
    render(<CurrentWorkControlView onOpenItem={() => undefined} />)

    fireEvent.click(await screen.findByRole('button', { name: /旧任务.*查看任务详情/ }))
    fireEvent.click(screen.getByRole('button', { name: /新任务.*查看任务详情/ }))
    expect(await screen.findByText('新渠道 · new-model')).toBeInTheDocument()
    resolveOld?.({
      ok: true,
      status: 200,
      data: {
        decisions: [{ profile: 'cheap', candidates: [{ provider: '旧渠道', model: 'old-model' }] }]
      }
    })
    await waitFor(() => expect(screen.queryByText('旧渠道 · old-model')).not.toBeInTheDocument())
    expect(screen.getByText('新渠道 · new-model')).toBeInTheDocument()
  })

  it('starts HUD, task, and decision reads in parallel', async () => {
    const calls: string[] = []
    let resolveHud!: (value: DaoControlResponse) => void
    let resolveTasks!: (value: DaoControlResponse) => void
    let resolveDecisions!: (value: DaoControlResponse) => void
    const requestControl = vi.fn<DesktopHost['requestControl']>((path) => {
      calls.push(path)
      if (path === '/origin/hud/snapshot') {
        return new Promise((resolve) => {
          resolveHud = resolve
        })
      }
      if (path === '/origin/tasks') {
        return new Promise((resolve) => {
          resolveTasks = resolve
        })
      }
      if (path === '/origin/ea/decision-inbox?limit=50') {
        return new Promise((resolve) => {
          resolveDecisions = resolve
        })
      }
      throw new Error(`unexpected ${path}`)
    })
    installHost(requestControl)
    render(<CurrentWorkControlView onOpenItem={() => undefined} />)

    await waitFor(() =>
      expect(calls).toEqual([
        '/origin/hud/snapshot',
        '/origin/tasks',
        '/origin/ea/decision-inbox?limit=50'
      ])
    )
    resolveHud({ ok: true, status: 200, data: { sessions: [], tasks: [] } })
    resolveTasks({ ok: true, status: 200, data: { tasks: [] } })
    resolveDecisions({ ok: true, status: 200, data: { items: [] } })
    await waitFor(() => expect(screen.getByText('目前没有需要你处理的异常。')).toBeInTheDocument())
  })

  it('offers plain navigation actions when the desk has no work', async () => {
    installHost(
      vi.fn<DesktopHost['requestControl']>(async () => ({
        ok: true,
        status: 200,
        data: { sessions: [], tasks: [] }
      }))
    )
    const onNavigate = vi.fn()
    render(<CurrentWorkControlView onOpenItem={() => undefined} onNavigate={onNavigate} />)

    expect(await screen.findByText('目前没有需要你处理的异常。')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '查看实时情况' }))
    fireEvent.click(screen.getByRole('button', { name: '查看接入渠道' }))
    expect(onNavigate).toHaveBeenNthCalledWith(1, 'hud')
    expect(onNavigate).toHaveBeenNthCalledWith(2, 'providers')
  })

  it('combines safe acknowledgements with local Taskboard plan work', async () => {
    const failedTask = {
      jobId: 'private-failed-job',
      source: 'codex',
      taskType: 'build',
      commandSummary: '构建失败待处理',
      status: 'failed',
      phase: '验证失败',
      updatedAt: Date.now(),
      result: { status: 'failed', errorCategory: 'verification' }
    }
    const requestControl = vi.fn<DesktopHost['requestControl']>(async (path) => {
      if (path === '/origin/hud/snapshot') {
        return { ok: true, status: 200, data: { sessions: [], tasks: [failedTask] } }
      }
      if (path === '/origin/tasks') {
        return { ok: true, status: 200, data: { tasks: [failedTask] } }
      }
      if (path === '/origin/ea/routing-decisions?profile=balanced&limit=20') {
        return { ok: true, status: 200, data: { decisions: [] } }
      }
      if (path === '/origin/ea/handoff.md') {
        return { ok: true, status: 200, data: '' }
      }
      throw new Error(`unexpected ${path}`)
    })
    const getResolvedWork = vi.fn<NonNullable<DesktopHost['getResolvedWork']>>(async () => [])
    const resolveWork = vi.fn<NonNullable<DesktopHost['resolveWork']>>(async () => undefined)
    const getTaskboardSnapshot = vi.fn<NonNullable<DesktopHost['getTaskboardSnapshot']>>(
      async () => ({
        state: 'connected',
        writable: false,
        message: '已连接；加入任务板需要从当前 Codex 任务发起。',
        items: [
          {
            identifier: 'DAOFLOW-7',
            title: '生命周期收口',
            status: 'in_progress',
            priority: 'high',
            updatedAt: Date.now()
          }
        ]
      })
    )
    const createTaskboardWork = vi.fn<NonNullable<DesktopHost['createTaskboardWork']>>()
    installHost(requestControl, {
      getResolvedWork,
      resolveWork,
      getTaskboardSnapshot,
      createTaskboardWork
    })
    render(<CurrentWorkControlView onOpenItem={() => undefined} />)

    expect(await screen.findByText('运行中 0')).toBeInTheDocument()
    expect(screen.getByText('待处理 1')).toBeInTheDocument()
    expect(await screen.findByText('计划事项 1')).toBeInTheDocument()
    expect(screen.getByText('生命周期收口')).toBeInTheDocument()
    expect(getResolvedWork).toHaveBeenCalledWith([expect.stringMatching(/^[a-f0-9]{32}$/)])

    fireEvent.click(screen.getByRole('button', { name: /构建失败待处理.*查看任务详情/ }))
    fireEvent.click(screen.getByRole('button', { name: '加入任务板' }))
    expect(screen.getByRole('dialog', { name: '加入任务板预览' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '确认加入任务板' })).toBeDisabled()
    expect(createTaskboardWork).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    fireEvent.click(screen.getByRole('button', { name: '我知道了' }))
    await waitFor(() => expect(resolveWork).toHaveBeenCalledTimes(1))
    expect(resolveWork).toHaveBeenCalledWith(
      expect.stringMatching(/^[a-f0-9]{32}$/),
      'acknowledged'
    )
    expect(screen.queryByText('构建失败待处理')).not.toBeInTheDocument()
    expect(screen.queryByText('private-failed-job')).not.toBeInTheDocument()
  })

  it('promotes attention only after attributed preview confirmation', async () => {
    const failedTask = {
      jobId: 'private-promote-job',
      source: 'codex',
      taskType: 'build',
      commandSummary: '连接中断待跟进',
      status: 'transport_lost',
      phase: '连接中断',
      updatedAt: Date.now(),
      result: { status: 'failed', errorCategory: 'transport' }
    }
    const requestControl = vi.fn<DesktopHost['requestControl']>(async (path) => {
      if (path === '/origin/hud/snapshot' || path === '/origin/tasks') {
        return { ok: true, status: 200, data: { sessions: [], tasks: [failedTask] } }
      }
      if (path.includes('/origin/ea/routing-decisions')) {
        return { ok: true, status: 200, data: { decisions: [] } }
      }
      if (path === '/origin/ea/handoff.md') return { ok: true, status: 200, data: '' }
      throw new Error(`unexpected ${path}`)
    })
    const resolveWork = vi.fn<NonNullable<DesktopHost['resolveWork']>>(async () => undefined)
    const createTaskboardWork = vi.fn<NonNullable<DesktopHost['createTaskboardWork']>>(
      async () => ({
        identifier: 'DAOFLOW-8',
        title: '连接中断待跟进',
        status: 'todo',
        priority: 'medium',
        updatedAt: Date.now()
      })
    )
    installHost(requestControl, {
      getResolvedWork: async () => [],
      resolveWork,
      getTaskboardSnapshot: async () => ({
        state: 'connected',
        writable: true,
        message: '已连接本地 Taskboard。',
        items: []
      }),
      createTaskboardWork
    })
    render(<CurrentWorkControlView onOpenItem={() => undefined} />)

    fireEvent.click(await screen.findByRole('button', { name: /连接中断待跟进.*查看任务详情/ }))
    fireEvent.click(screen.getByRole('button', { name: '加入任务板' }))
    expect(createTaskboardWork).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '确认加入任务板' }))

    await waitFor(() => expect(createTaskboardWork).toHaveBeenCalledTimes(1))
    expect(createTaskboardWork).toHaveBeenCalledWith({
      fingerprint: expect.stringMatching(/^[a-f0-9]{32}$/),
      title: '连接中断待跟进',
      sourceKind: 'task',
      failureKind: 'transport_lost',
      acceptance: '确认连接恢复并完成一次验证。'
    })
    expect(resolveWork).toHaveBeenCalledWith(
      expect.stringMatching(/^[a-f0-9]{32}$/),
      'promoted',
      'DAOFLOW-8'
    )
    expect(screen.queryByText('连接中断待跟进')).not.toBeInTheDocument()
    expect(screen.queryByText('private-promote-job')).not.toBeInTheDocument()
  })
})
