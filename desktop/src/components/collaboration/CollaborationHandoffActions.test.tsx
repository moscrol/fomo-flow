// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { DesktopHost } from '@/lib/desktopHost'

import { CollaborationHandoffActions } from './CollaborationHandoffActions'

function installHost(
  writeClipboard: DesktopHost['writeClipboard'],
  saveHandoff: DesktopHost['saveHandoff']
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
      refreshedAt: 0,
      partial: false,
      availableModelCount: 0,
      routerReady: false,
      eaRunning: false,
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
    requestControl: async () => ({ ok: true, status: 200, data: {} }),
    saveHandoff,
    writeClipboard
  }
}

afterEach(() => {
  cleanup()
  delete window.desktopHost
})

describe('CollaborationHandoffActions', () => {
  it('copies and saves the exact safe content with explicit outcomes', async () => {
    const user = userEvent.setup()
    const writeClipboard = vi.fn(async () => undefined)
    const saveHandoff = vi.fn<DesktopHost['saveHandoff']>(async () => ({ ok: true }))
    installHost(writeClipboard, saveHandoff)

    render(
      <CollaborationHandoffActions
        content={'# FOMO ACP 会话交接\n安全摘要'}
        filename="dao-acp-session-handoff.md"
      />
    )

    await user.click(screen.getByRole('button', { name: '复制交接包' }))
    expect(writeClipboard).toHaveBeenCalledWith('# FOMO ACP 会话交接\n安全摘要')
    expect(screen.getByRole('status')).toHaveTextContent('交接包已复制')

    await user.click(screen.getByRole('button', { name: '另存交接包' }))
    expect(saveHandoff).toHaveBeenCalledWith(
      '# FOMO ACP 会话交接\n安全摘要',
      'dao-acp-session-handoff.md'
    )
    expect(screen.getByRole('status')).toHaveTextContent('交接包已保存')

    saveHandoff.mockResolvedValue({ ok: false, canceled: true })
    await user.click(screen.getByRole('button', { name: '另存交接包' }))
    expect(screen.getByRole('status')).toHaveTextContent('已取消保存')
  })

  it('disables actions when there is no handoff content', () => {
    installHost(
      vi.fn(async () => undefined),
      vi.fn(async () => ({ ok: true }))
    )
    render(<CollaborationHandoffActions content="" filename="handoff.md" />)
    expect(screen.getByRole('button', { name: '复制交接包' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '另存交接包' })).toBeDisabled()
  })
})
