// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { DesktopHost } from '@/lib/desktopHost'

import { CustomModelsControlView } from './CustomModelsControlView'

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
  cleanup()
  delete window.desktopHost
})

describe('native custom models control view', () => {
  it('explains when runtime uses a provider-compatible protocol', async () => {
    const requestControl = vi.fn(async (path: string) => {
      if (path === '/origin/ea/custom-models') {
        return {
          ok: true,
          status: 200,
          data: {
            ok: true,
            models: [
              {
                id: 'dao-opus-5',
                label: 'Claude Opus 5',
                protocol: 'anthropic',
                channelStrategy: 'priority',
                channels: [
                  {
                    provider: 'cccc',
                    upstreamModel: 'claude-opus-5',
                    protocol: 'anthropic'
                  }
                ],
                runtime: {
                  state: 'active',
                  provider: 'cccc',
                  model: 'claude-opus-5',
                  configuredProtocol: 'anthropic',
                  actualProtocol: 'openai-chat',
                  protocolAdjusted: true,
                  protocolReason: 'configured-protocol-unsupported'
                }
              }
            ]
          }
        }
      }
      if (path === '/origin/ea/providers') {
        return {
          ok: true,
          status: 200,
          data: { ok: true, providers: { cccc: { models: ['claude-opus-5'] } } }
        }
      }
      return { ok: false, status: 404, data: { error: 'unexpected request' } }
    })
    installHost(requestControl)

    render(<CustomModelsControlView />)

    expect(await screen.findByText(/实际使用 OpenAI Chat/)).toBeInTheDocument()
    expect(screen.getByText('渠道不支持配置协议，已按渠道能力发送')).toBeInTheDocument()
    expect(document.body.textContent).not.toContain('Authorization')
    expect(document.body.textContent).not.toContain('https://')
  })

  it('lets the user manually promote a channel before saving priority order', async () => {
    const user = userEvent.setup()
    const requestControl = vi.fn(async (path: string, method = 'GET') => {
      if (path === '/origin/ea/custom-models' && method === 'GET') {
        return {
          ok: true,
          status: 200,
          data: {
            ok: true,
            models: [
              {
                id: 'dao-demo',
                label: 'Dao Demo',
                channelStrategy: 'priority',
                contextTokens: 128000,
                maxOutputTokens: 16000,
                channels: [
                  {
                    provider: 'primary',
                    upstreamModel: 'm1',
                    protocol: 'openai-chat',
                    reasoningLevel: 'off'
                  },
                  {
                    provider: 'backup',
                    upstreamModel: 'm2',
                    protocol: 'openai-chat',
                    reasoningLevel: 'off'
                  }
                ],
                runtime: { state: 'active', provider: 'primary', model: 'm1' },
                capabilities: { supportsTools: true }
              }
            ]
          }
        }
      }
      if (path === '/origin/ea/providers') {
        return {
          ok: true,
          status: 200,
          data: {
            ok: true,
            providers: {
              primary: { models: ['m1'] },
              backup: { models: ['m2'] }
            }
          }
        }
      }
      if (path === '/origin/ea/custom-model' && method === 'POST') {
        return { ok: true, status: 200, data: { ok: true } }
      }
      return { ok: false, status: 404, data: { error: `unexpected ${method} ${path}` } }
    })
    installHost(requestControl)

    render(<CustomModelsControlView />)

    expect(await screen.findByText('Dao Demo')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '编辑' }))
    expect(screen.getByLabelText('手动渠道优先级')).toBeInTheDocument()

    await user.click(screen.getAllByRole('button', { name: '置顶' })[1])
    expect(
      requestControl.mock.calls.some(
        ([path, method]) => path === '/origin/ea/custom-model' && method === 'POST'
      )
    ).toBe(false)
    await user.click(screen.getByRole('button', { name: '保存并同步' }))

    await waitFor(() =>
      expect(requestControl).toHaveBeenCalledWith(
        '/origin/ea/custom-model',
        'POST',
        expect.objectContaining({
          id: 'dao-demo',
          channelStrategy: 'priority',
          channels: [
            expect.objectContaining({ provider: 'backup', upstreamModel: 'm2' }),
            expect.objectContaining({ provider: 'primary', upstreamModel: 'm1' })
          ]
        })
      )
    )
  })
})
