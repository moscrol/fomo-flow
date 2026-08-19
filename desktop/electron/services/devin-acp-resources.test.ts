import { describe, expect, it } from 'vitest'

import { DEVIN_MAC_ACP_PATH, resolveDevinAcpResources } from './devin-acp-resources'

describe('Devin ACP resources', () => {
  it('resolves only the fixed Devin binary and repository proxy in development', () => {
    const present = new Set([DEVIN_MAC_ACP_PATH, '/repo/dao-acp-stdio-proxy.js'])

    expect(
      resolveDevinAcpResources({
        appPath: '/repo/desktop',
        isPackaged: false,
        resourcesPath: '/Applications/FOMO FLOW.app/Contents/Resources',
        exists: (path) => present.has(path)
      })
    ).toEqual({
      available: true,
      devinPath: DEVIN_MAC_ACP_PATH,
      proxyPath: '/repo/dao-acp-stdio-proxy.js'
    })
  })

  it('uses the packaged proxy resource without accepting a configurable command path', () => {
    const proxyPath =
      '/Applications/FOMO FLOW.app/Contents/Resources/dao-acp-host/dao-acp-stdio-proxy.js'
    const present = new Set([DEVIN_MAC_ACP_PATH, proxyPath])

    expect(
      resolveDevinAcpResources({
        appPath: '/Applications/FOMO FLOW.app/Contents/Resources/app.asar',
        isPackaged: true,
        resourcesPath: '/Applications/FOMO FLOW.app/Contents/Resources',
        exists: (path) => present.has(path)
      })
    ).toEqual({ available: true, devinPath: DEVIN_MAC_ACP_PATH, proxyPath })
  })

  it('reports which fixed resource is missing without returning private paths', () => {
    expect(
      resolveDevinAcpResources({
        appPath: '/repo/desktop',
        isPackaged: false,
        resourcesPath: '/resources',
        exists: () => false
      })
    ).toEqual({ available: false, reason: 'devin_missing' })

    expect(
      resolveDevinAcpResources({
        appPath: '/repo/desktop',
        isPackaged: false,
        resourcesPath: '/resources',
        exists: (path) => path === DEVIN_MAC_ACP_PATH
      })
    ).toEqual({ available: false, reason: 'proxy_missing' })
  })
})
