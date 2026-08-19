// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { DesktopHost } from '@/lib/desktopHost'

import { TaskCenterControlView } from './TaskCenterControlView'

function installHost(
  requestControl: DesktopHost['requestControl'],
  saveHandoff: DesktopHost['saveHandoff'] = async () => ({ ok: true })
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
    saveHandoff,
    writeClipboard: async () => undefined
  }
}

afterEach(() => {
  delete window.desktopHost
})

describe('native task center', () => {
  it('renders task lifecycle, fallback attempts and handoff artifacts', async () => {
    const requestControl = vi.fn(async (path: string) => {
      if (path === '/origin/tasks') {
        return {
          ok: true,
          status: 200,
          data: {
            ok: true,
            tasks: [
              {
                jobId: 'job-1',
                source: 'codex',
                taskType: 'codex-turn',
                workspace: '/Users/demo/project',
                status: 'running',
                phase: '验证',
                progress: '2/4',
                updatedAt: Date.now(),
                attempts: [
                  {
                    provider: 'primary',
                    model: 'dao-opus-5',
                    fallbackUsed: true,
                    fallbackReason: 'timeout'
                  }
                ],
                result: { artifacts: [{ path: '/Users/demo/project/patch.diff', kind: 'diff' }] }
              }
            ]
          }
        }
      }
      return { ok: true, status: 200, data: { tasks: [] } }
    })
    const saveHandoff = vi.fn(async () => ({ ok: true }))
    installHost(requestControl, saveHandoff)

    render(<TaskCenterControlView />)

    expect(await screen.findByRole('heading', { name: '任务中心' })).toBeInTheDocument()
    expect(await screen.findByText('Codex turn（运行事实）')).toBeInTheDocument()
    expect(screen.getByText('Codex turn 只保留运行状态，未保存正文。')).toBeInTheDocument()
    expect(screen.getByText(/fallback · timeout/)).toBeInTheDocument()
    expect(screen.getByText('patch.diff')).toBeInTheDocument()
    await screen.findByRole('button', { name: '另存交接包' })
    fireEvent.click(screen.getByRole('button', { name: '另存交接包' }))
    await waitFor(() =>
      expect(saveHandoff).toHaveBeenCalledWith(
        expect.stringContaining('# Dao 协作任务交接'),
        'dao-acp-task-handoff.md'
      )
    )

    fireEvent.click(screen.getByRole('button', { name: '失败' }))
    await waitFor(() => expect(screen.getByText('当前筛选下没有任务。')).toBeInTheDocument())
  })

  it('shows a readable error when both task projections fail', async () => {
    const requestControl = vi.fn(async () => ({
      ok: false,
      status: 503,
      data: { error: 'task api unavailable' }
    }))
    installHost(requestControl)

    render(<TaskCenterControlView />)

    expect(await screen.findByText('task api unavailable')).toBeInTheDocument()
    expect(screen.getByText('任务读取失败，稍后重试。')).toBeInTheDocument()
  })
})
