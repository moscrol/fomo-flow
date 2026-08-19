// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { DaoControlResponse, DesktopHost } from '@/lib/desktopHost'

import { ProvidersControlView } from './ProvidersControlView'

const token = '17'.repeat(32)

function controlData(path: string): unknown {
  if (path === '/origin/ea/providers') {
    return {
      providers: {
        desktop: { _label: 'Desktop 渠道', baseUrl: 'https://example.invalid', models: ['m1'] }
      }
    }
  }
  if (path === '/origin/ea/overview') {
    return { router_ready: true, routes: { default: {} }, custom_models: [] }
  }
  if (path === '/origin/ea/usage') return { totals: { calls: 0, total: 0 } }
  return {}
}

function installHost() {
  const requestControl = vi.fn<DesktopHost['requestControl']>(
    async (path): Promise<DaoControlResponse> => ({
      ok: true,
      status: 200,
      data: controlData(path)
    })
  )
  const previewChannelMigration = vi.fn<NonNullable<DesktopHost['previewChannelMigration']>>(
    async () => ({
      available: true,
      sourceLabel: '现有 FOMO FLOW 配置',
      providerNames: ['glm'],
      providerCount: 25,
      customModelCount: 9,
      routeCount: 64,
      newProviderCount: 24,
      overwrittenProviderCount: 1,
      preservedDesktopProviderCount: 1,
      priorityPreserved: true,
      confirmationToken: token,
      message: '找到可迁移的现有 FOMO FLOW 渠道与路由。'
    })
  )
  const applyChannelMigration = vi.fn<NonNullable<DesktopHost['applyChannelMigration']>>(
    async () => ({
      ok: true,
      providerCount: 25,
      customModelCount: 9,
      routeCount: 64,
      backupCreated: true,
      priorityPreserved: true,
      reloadReflected: true,
      message: '现有 FOMO FLOW 渠道与路由已安全导入。'
    })
  )

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
    getDashboardSnapshot: async () =>
      ({}) as Awaited<ReturnType<DesktopHost['getDashboardSnapshot']>>,
    openExternal: async () => undefined,
    openConfig: async () => undefined,
    openControlConsole: async () => undefined,
    requestControl,
    saveHandoff: async () => ({ ok: true }),
    writeClipboard: async () => undefined,
    previewChannelMigration,
    applyChannelMigration
  }

  return { requestControl, previewChannelMigration, applyChannelMigration }
}

afterEach(() => {
  cleanup()
  delete window.desktopHost
})

describe('Providers control channel migration', () => {
  it('refreshes existing read-only data after the explicitly confirmed import', async () => {
    const { requestControl, applyChannelMigration } = installHost()
    render(<ProvidersControlView />)

    expect(await screen.findByText('Desktop 渠道')).toBeInTheDocument()
    expect(requestControl).toHaveBeenCalledTimes(3)
    fireEvent.click(screen.getByRole('button', { name: '检查现有 FOMO FLOW 配置' }))
    await screen.findByText('25 个渠道')
    fireEvent.click(screen.getByRole('button', { name: '导入渠道与路由' }))
    fireEvent.click(screen.getByRole('button', { name: '确认导入' }))

    await waitFor(() => expect(requestControl).toHaveBeenCalledTimes(6))
    expect(applyChannelMigration).toHaveBeenCalledWith(token)
    expect(requestControl.mock.calls.map(([path, method]) => [path, method ?? 'GET'])).toEqual([
      ['/origin/ea/providers', 'GET'],
      ['/origin/ea/overview', 'GET'],
      ['/origin/ea/usage', 'GET'],
      ['/origin/ea/providers', 'GET'],
      ['/origin/ea/overview', 'GET'],
      ['/origin/ea/usage', 'GET']
    ])
  })
})
