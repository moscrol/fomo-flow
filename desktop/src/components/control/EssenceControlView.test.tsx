// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { DesktopHost } from '@/lib/desktopHost'

import { EssenceControlView } from './EssenceControlView'

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
      refreshedAt: 0,
      providers: [],
      routes: [],
      availableModelCount: 0,
      routerReady: false,
      eaRunning: false,
      familyTierExtend: false,
      partial: false,
      usage: { calls: 0, input: 0, output: 0, total: 0 },
      failureProviders: [],
      revproxy: {
        enabled: false,
        port: null,
        hasKey: false,
        dualPath: false,
        exposeLan: false,
        applyInvert: false,
        isolatePrompt: false,
        modelCount: 0,
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

describe('native essence control', () => {
  it('loads independent endpoints and applies a mode change', async () => {
    const user = userEvent.setup()
    const requestControl = vi.fn(async (path: string, method = 'GET') => {
      if (method === 'POST') return { ok: true, status: 200, data: { ok: true } }
      if (path === '/origin/mode')
        return { ok: true, status: 200, data: { mode: 'invert', valid: ['invert', 'passthrough'] } }
      if (path === '/origin/canon')
        return {
          ok: true,
          status: 200,
          data: { canon: 'laozi+yinfu', canon_name: '老子', map: { 'laozi+yinfu': '老子 · 音符' } }
        }
      if (path === '/origin/preview') return { ok: true, status: 200, data: { after: 'preview' } }
      return { ok: true, status: 200, data: { sp: '默认', has_custom: false } }
    })
    installHost(requestControl)

    render(<EssenceControlView />)
    expect(await screen.findByRole('heading', { name: '本源观照' })).toBeInTheDocument()
    const mode = await screen.findByLabelText('注入模式')
    await user.selectOptions(mode, 'passthrough')

    await waitFor(() => {
      expect(requestControl).toHaveBeenCalledWith('/origin/mode', 'POST', { mode: 'passthrough' })
    })
    expect(screen.getByText(/模式已切换/)).toBeInTheDocument()
  })
})
