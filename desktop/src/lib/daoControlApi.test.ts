// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'

import type { DesktopHost } from './desktopHost'
import { daoControlApi } from './daoControlApi'

describe('native Dao control API wrapper', () => {
  it('treats a 200 response with ok:false as a failed action', async () => {
    const host: DesktopHost = {
      getRuntimeStatus: async () => ({
        healthy: false,
        running: false,
        port: null,
        url: null,
        profile: 'desktop',
        imported: { config: false, revproxy: false },
        error: null
      }),
      retryRuntime: async () => ({
        healthy: false,
        running: false,
        port: null,
        url: null,
        profile: 'desktop',
        imported: { config: false, revproxy: false },
        error: null
      }),
      getDashboardSnapshot: async () => ({
        refreshedAt: 0,
        partial: true,
        availableModelCount: 0,
        routerReady: false,
        eaRunning: false,
        familyTierExtend: false,
        providers: [],
        routes: [],
        usage: { calls: 0, input: 0, output: 0, total: 0 },
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
        },
        failureProviders: []
      }),
      openExternal: vi.fn(),
      openConfig: vi.fn(),
      openControlConsole: vi.fn(),
      requestControl: vi.fn(async () => ({
        ok: true,
        status: 200,
        data: { ok: false, error: 'provider rejected' }
      })),
      saveHandoff: vi.fn(),
      writeClipboard: vi.fn()
    }
    window.desktopHost = host
    await expect(daoControlApi().request('/origin/ea/probe', 'POST', {})).rejects.toThrow(
      'provider rejected'
    )
    delete window.desktopHost
  })
})
