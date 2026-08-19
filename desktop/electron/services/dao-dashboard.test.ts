import { describe, expect, it } from 'vitest'

import type { DaoDesktopStatus } from '../../src/lib/desktopHost/types'
import { createDaoDashboardService } from './dao-dashboard'

const status: DaoDesktopStatus = {
  healthy: true,
  running: true,
  port: 8955,
  url: 'http://127.0.0.1:8955',
  profile: 'desktop',
  imported: { config: true, revproxy: true },
  error: null
}

describe('Dao dashboard service', () => {
  it('returns a redacted, bounded snapshot from the existing control APIs', async () => {
    const paths: string[] = []
    const service = createDaoDashboardService({
      getStatus: () => status,
      readJson: async (path) => {
        paths.push(path)
        if (path.endsWith('/overview'))
          return {
            available_models: ['m1', 'm2'],
            router_ready: true,
            ea_running: true,
            family_tier_extend: true,
            providers: {
              cloud: {
                label: 'Cloud',
                type: 'openai',
                baseUrl: 'https://user:secret@example.com/v1?token=bad',
                apiKey: 'sk-do-not-copy',
                models: ['m1'],
                enabled: true,
                health: { alive: true, status: 200, reason: 'ok' },
                usage: { calls: 3, input: 10, output: 7 }
              },
              stub: { _builtin: true, _label: '测试通道', type: 'mock', models: ['stub'] }
            },
            routes: {
              m1: {
                provider: 'cloud',
                model: 'upstream-m1',
                channelPriority: [{ provider: 'backup' }]
              }
            }
          }
        if (path.endsWith('/usage'))
          return { totals: { calls: 3, input: 10, output: 7, total: 17 } }
        if (path.endsWith('/failure-stats'))
          return {
            stats: {
              cloud: {
                total: 2,
                topKind: 'auth',
                kinds: { auth: { count: 2, samples: [{ error: 'secret' }] } }
              }
            }
          }
        return {
          enabled: true,
          port: 8955,
          model_count: 2,
          hasKey: true,
          apiKey: 'secret-key',
          applyInvert: true,
          exposeLan: false
        }
      },
      now: () => 123
    })

    const snapshot = await service.snapshot()
    expect(paths).toHaveLength(4)
    expect(snapshot.refreshedAt).toBe(123)
    expect(snapshot.providers[0]).toMatchObject({
      name: 'cloud',
      endpointHost: 'example.com',
      modelCount: 1
    })
    expect(snapshot.providers[0]).not.toHaveProperty('apiKey')
    expect(snapshot.routes[0]).toMatchObject({ uid: 'm1', provider: 'cloud', fallbackCount: 1 })
    expect(snapshot.usage.total).toBe(17)
    expect(snapshot.revproxy).toMatchObject({ enabled: true, hasKey: true, port: 8955 })
    expect(snapshot.failureProviders).toEqual([
      { name: 'cloud', total: 2, topKind: 'auth', kinds: [{ kind: 'auth', count: 2 }] }
    ])
    expect(JSON.stringify(snapshot)).not.toContain('secret')
  })

  it('marks unavailable runtime without attempting network calls', async () => {
    let reads = 0
    const service = createDaoDashboardService({
      getStatus: () => ({ ...status, healthy: false, url: null, port: null }),
      readJson: async () => {
        reads += 1
        return {}
      },
      now: () => 456
    })
    const snapshot = await service.snapshot()
    expect(reads).toBe(0)
    expect(snapshot).toMatchObject({ refreshedAt: 456, partial: true, providers: [] })
  })

  it('reads usage and failures from the selected observation source only', async () => {
    const desktopPaths: string[] = []
    const observationPaths: string[] = []
    const service = createDaoDashboardService({
      getStatus: () => status,
      readJson: async (path) => {
        desktopPaths.push(path)
        return path.endsWith('/overview') ? { usage: { calls: 1 } } : {}
      },
      readObservationJson: async (path) => {
        observationPaths.push(path)
        if (path.endsWith('/usage')) return { totals: { calls: 9, input: 20, output: 5 } }
        return { stats: {} }
      }
    })

    const snapshot = await service.snapshot()

    expect(desktopPaths).toEqual(['/origin/ea/overview', '/origin/revproxy/status'])
    expect(observationPaths).toEqual(['/origin/ea/usage', '/origin/ea/failure-stats'])
    expect(snapshot.usage).toMatchObject({ calls: 9, total: 25 })
  })
})
