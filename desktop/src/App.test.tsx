// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { DesktopHost } from '@/lib/desktopHost'

import { App } from './App'

describe('Dao React workspace', () => {
  afterEach(() => {
    cleanup()
    delete window.desktopHost
  })

  it('opens retained configuration capabilities from the Settings shell', async () => {
    render(<App initialView="settings" />)

    expect(await screen.findByRole('heading', { name: '设置', level: 2 })).toBeInTheDocument()
    expect(screen.getByRole('navigation', { name: '设置分区' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /模型路由/ }))

    expect(await screen.findByRole('heading', { name: '模型怎么走' })).toBeInTheDocument()
    expect(await screen.findByRole('button', { name: '路由' })).toHaveAttribute(
      'aria-current',
      'page'
    )
    expect(screen.getByRole('button', { name: '设置' })).toHaveAttribute('aria-current', 'page')
  })

  it('keeps a work card on the desk and navigates only from its explicit action', async () => {
    const requestControl = vi.fn<DesktopHost['requestControl']>(async (path) => {
      if (path === '/origin/hud/snapshot') {
        return {
          ok: true,
          status: 200,
          data: {
            sessions: [
              {
                id: 'session-app-1',
                surface: 'codex',
                active: true,
                goal: '在 App 中复核工作台',
                phase: '验证',
                latestActivityAt: Date.now()
              }
            ],
            tasks: []
          }
        }
      }
      if (path === '/origin/tasks') return { ok: true, status: 200, data: { tasks: [] } }
      if (path.startsWith('/origin/ea/')) return { ok: true, status: 200, data: {} }
      throw new Error('not needed')
    })
    window.desktopHost = {
      requestControl,
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
      saveHandoff: async () => ({ ok: true }),
      writeClipboard: async () => undefined
    }

    render(<App initialView="work" />)
    expect(await screen.findByRole('region', { name: '刚刚发生' })).toBeInTheDocument()
    expect(
      await screen.findByRole('button', { name: /在 App 中复核工作台.*查看协作会话/ })
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /在 App 中复核工作台.*查看协作会话/ }))
    expect(screen.getByRole('heading', { name: '当前工作', level: 1 })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: '工作舱' })).toBeInTheDocument()
    expect(document.body.textContent).not.toContain('session-app-1')
    fireEvent.click(screen.getByRole('button', { name: '打开协作会话' }))
    expect(await screen.findByRole('heading', { name: 'ACP 协作' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'ACP 协作' })).toHaveAttribute('aria-current', 'page')
    expect(await screen.findByRole('button', { name: '协作总览' })).toHaveAttribute(
      'aria-current',
      'page'
    )
  })

  it('defaults to 当前工作 and places it first in runtime navigation', async () => {
    render(<App />)

    expect(await screen.findByRole('heading', { name: '当前工作' })).toBeInTheDocument()
    const runtimeButtons = within(
      screen.getByRole('navigation', { name: 'Dao 主要功能' })
    ).getAllByRole('button')
    expect(runtimeButtons.map((button) => button.getAttribute('aria-label'))).toEqual([
      '当前工作',
      '流量观测',
      'ACP 协作',
      '设置'
    ])
    expect(
      runtimeButtons.find((button) => button.getAttribute('aria-current') === 'page')
    ).toHaveTextContent('当前工作')
  })

  it('opens the read-only operations health desk inside traffic observation', async () => {
    render(<App initialView="operations" />)

    expect(await screen.findByRole('heading', { name: '运行健康' })).toBeInTheDocument()
    expect(
      within(screen.getByRole('navigation', { name: '流量观测分区' })).getByRole('button', {
        name: '运行健康'
      })
    ).toHaveAttribute('aria-current', 'page')
    expect(await screen.findByText(/不会自动修改 provider、model 或 priority/)).toBeInTheDocument()
  })

  it('opens the decision center as a first-class workbench view', async () => {
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
    window.desktopHost = {
      requestControl,
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
      saveHandoff: async () => ({ ok: true }),
      writeClipboard: async () => undefined
    }

    render(<App initialView="decisions" />)

    expect(await screen.findByRole('heading', { name: '路由观察与处理' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '流量观测' })).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('button', { name: '为什么这样走' })).toHaveAttribute(
      'aria-current',
      'page'
    )
    await waitFor(() =>
      expect(requestControl).toHaveBeenCalledWith(
        '/origin/ea/decision-inbox?limit=50',
        'GET',
        undefined
      )
    )
  })

  it('keeps hidden legacy views reachable from the command palette', () => {
    render(<App initialView="work" />)
    fireEvent.click(screen.getByRole('button', { name: /快速跳转/ }))

    expect(screen.getByRole('option', { name: /首页/ })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: /模型怎么走/ })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: /Devin 接入/ })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: /任务进度/ })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: /接入渠道/ })).toBeInTheDocument()
  })

  it('opens native-first Devin access as a first-class collaboration view', async () => {
    render(<App initialView="devinConnect" />)

    expect(await screen.findByRole('heading', { name: 'Devin 接入' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'ACP 协作' })).toHaveAttribute('aria-current', 'page')
    expect(await screen.findByRole('button', { name: '添加 Agent' })).toHaveAttribute(
      'aria-current',
      'page'
    )
    expect(await screen.findByText(/默认打开 Devin 原生窗口/)).toBeInTheDocument()
  })

  it('starts with a navigable Dao overview', () => {
    render(<App initialView="overview" />)

    expect(screen.getByRole('heading', { name: '首页' })).toBeInTheDocument()
    expect(screen.getAllByText('模型网关与协作工作台').length).toBeGreaterThan(0)
    expect(screen.getByRole('button', { name: '流量观测' })).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('button', { name: '现在是否正常' })).toHaveAttribute(
      'aria-current',
      'page'
    )
    expect(screen.getByText('本地运行时')).toBeInTheDocument()
  })
})
