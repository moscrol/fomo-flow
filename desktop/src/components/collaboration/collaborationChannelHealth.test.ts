import { describe, expect, it } from 'vitest'

import { normalizeCollaborationSnapshot } from './collaborationModel'
import { buildCollaborationChannelHealth } from './collaborationChannelHealth'

describe('collaboration channel health model', () => {
  it('unifies providers and usage projections, preserving health facts and safe labels', () => {
    const snapshot = normalizeCollaborationSnapshot({
      providers: [
        {
          id: 'bridge',
          latency: {
            overall: { p95TtftMs: 720 },
            cache: { hit: { p95TtftMs: 180 }, miss: { p95TtftMs: 420 } }
          }
        },
        { id: 'idle-provider' }
      ],
      sessions: [
        { id: 'session-a', route: { provider: 'bridge' } },
        { id: 'session-b', route: { provider: 'bridge' } },
        { id: 'session-private', route: { provider: 'Bearer sk-private-token' } },
        { id: 'session-unbound' }
      ],
      recentRequests: [
        { id: 'request-1', provider: 'bridge', success: true },
        { id: 'request-2', provider: 'bridge', status: 'failed', success: false },
        { id: 'request-private', provider: '/Users/demo/private-provider', status: 'failed' }
      ]
    })

    const items = buildCollaborationChannelHealth(
      snapshot.providers,
      snapshot.sessions,
      snapshot.recentRequests
    )

    expect(items.map((item) => item.provider)).toEqual([
      'bridge',
      '[路径已隐藏]',
      '[凭据已隐藏]',
      'idle-provider'
    ])
    expect(items[0]).toMatchObject({
      sessionCount: 2,
      requestCount: 2,
      failureCount: 1,
      overallP95TtftMs: 720,
      cacheHitP95TtftMs: 180,
      cacheMissP95TtftMs: 420,
      tone: 'bad'
    })
    expect(items[0].status).toContain('1 次失败')
    expect(JSON.stringify(items)).not.toContain('session-a')
    expect(JSON.stringify(items)).not.toContain('sk-private-token')
    expect(items.map((item) => item.provider)).not.toContain('自动选择')
  })

  it('orders traffic and failures deterministically and caps the matrix', () => {
    const sessions = normalizeCollaborationSnapshot({
      sessions: Array.from({ length: 14 }, (_, index) => ({
        id: `session-${index}`,
        route: { provider: `provider-${index}` }
      }))
    }).sessions
    const items = buildCollaborationChannelHealth([], sessions, [])
    const expectedProviders = Array.from({ length: 14 }, (_, index) => `provider-${index}`)
      .sort((left, right) => left.localeCompare(right))
      .slice(0, 12)

    expect(items).toHaveLength(12)
    expect(items.map((item) => item.provider)).toEqual(expectedProviders)
    expect(items.every((item) => item.sessionCount === 1 && item.tone === 'good')).toBe(true)
  })
})
