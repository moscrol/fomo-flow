import { describe, expect, it } from 'vitest'

import { toHudSnapshot } from './hudProjection'

describe('native HUD projection', () => {
  it('maps the sanitized Web HUD contract into bounded native display fields', () => {
    const snapshot = toHudSnapshot({
      version: 1,
      generatedAt: 123,
      runtime: {
        healthy: true,
        mode: 'invert',
        port: 8955,
        connection: 'live',
        componentWarnings: ['one'],
        sources: {
          codex: {
            toolSurface: 'classic-forced',
            toolSurfaceState: 'ok',
            diskToolMode: 'direct'
          }
        }
      },
      totals: { activeSessions: 2, cached: 9_999, hitRate: 87.5 },
      cachePolicy: { activeWarmups: 1, warmupSent: 2 },
      sessions: [
        {
          id: 'safe-id',
          surface: 'codex',
          goal: 'ship\nthis',
          active: true,
          latestActivityAt: 100,
          todo: { completed: 1, total: 2 },
          route: { provider: 'cc', modelUid: 'model', upstreamModel: 'upstream' },
          telemetry: { ttftMs: 120, durationMs: 480 },
          cache: { observed: true, hitRate: 50, calls: 2 }
        }
      ],
      providers: [
        {
          id: 'cc',
          state: 'alive',
          hitRate: 87.5,
          recentCalls: 0,
          recentHitRate: 0,
          latency: {
            overall: { p50TtftMs: 100, p95TtftMs: 200 },
            cache: { hit: { p95TtftMs: 50 }, miss: { p95TtftMs: 220 } }
          }
        }
      ],
      tasks: [{ id: 'safe-task', taskType: 'codex-turn', status: 'running' }],
      recentRequests: [
        {
          id: 'request',
          source: 'codex',
          cacheStatus: 'hit',
          ttftObserved: true,
          prefixState: 'rewritten',
          prefixGeneration: 2,
          prefixReason: 'stable-prefix-rewritten'
        }
      ]
    })

    expect(snapshot.runtime).toMatchObject({ healthy: true, mode: 'invert', port: 8955 })
    expect(snapshot.totals).toMatchObject({ activeSessions: 2, cached: 9_999, hitRate: 87.5 })
    expect(snapshot.sessions[0]).toMatchObject({
      id: 'safe-id',
      goal: 'ship this',
      route: { provider: 'cc', modelUid: 'model', upstreamModel: 'upstream' }
    })
    expect(snapshot.providers[0].latency.cache.miss.p95TtftMs).toBe(220)
    expect(snapshot.providers[0]).toMatchObject({ hitRate: 87.5, recentCalls: 0 })
    expect(snapshot.tasks[0]).toMatchObject({ id: 'safe-task', status: 'running' })
    expect(snapshot.recentRequests[0]).toMatchObject({
      id: 'request',
      cacheStatus: 'hit',
      prefixState: 'rewritten',
      prefixGeneration: 2,
      prefixReason: 'stable-prefix-rewritten'
    })
  })

  it('falls back safely for a malformed HUD response', () => {
    expect(toHudSnapshot({ sessions: [{}], providers: [null], tasks: 'bad' })).toMatchObject({
      version: 0,
      sessions: [{ id: 'unknown', goal: '当前会话未上报目标' }],
      providers: [{ id: 'unknown' }],
      tasks: [],
      recentRequests: []
    })
  })
})
