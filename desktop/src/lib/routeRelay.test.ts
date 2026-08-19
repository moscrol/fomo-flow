import { describe, expect, it } from 'vitest'

import { formatRelayRecovery, projectRouteRelay } from './routeRelay'

describe('route relay safe projection', () => {
  it('keeps configured priority while explaining safe skip and recovery facts', () => {
    const relay = projectRouteRelay({
      ok: true,
      plan: {
        configuredOrder: [
          { provider: 'first', model: 'm1', source: 'primary', actualPriority: 1 },
          { provider: 'second', model: 'm2', source: 'fallback', actualPriority: 2 }
        ],
        dispatchOrder: [{ provider: 'second', model: 'm2', source: 'fallback', actualPriority: 2 }],
        excluded: [
          {
            provider: 'first',
            model: 'm1',
            source: 'primary',
            actualPriority: 1,
            reason: 'circuit_open',
            circuitCategory: 'rate_limit',
            remainingMs: 90_000,
            upstreamBody: 'Authorization: Bearer SECRET_UPSTREAM_BODY',
            path: '/Users/private/relay'
          }
        ]
      }
    })

    expect(relay).toEqual([
      {
        provider: 'first',
        model: 'm1',
        actualPriority: 1,
        state: 'skipped',
        dispatchPosition: null,
        reasonLabel: '渠道暂时熔断',
        circuitCategory: 'rate_limit',
        circuitLabel: '上游限流',
        remainingMs: 90_000
      },
      {
        provider: 'second',
        model: 'm2',
        actualPriority: 2,
        state: 'ready',
        dispatchPosition: 1,
        reasonLabel: '',
        circuitCategory: null,
        circuitLabel: '',
        remainingMs: null
      }
    ])
    expect(JSON.stringify(relay)).not.toContain('SECRET_UPSTREAM_BODY')
    expect(JSON.stringify(relay)).not.toContain('/Users/private')
  })

  it('bounds unknown circuit data and formats a deterministic countdown', () => {
    const [hop] = projectRouteRelay({
      ok: true,
      plan: {
        configuredOrder: [{ provider: 'first', model: 'm1', actualPriority: 1 }],
        dispatchOrder: [],
        excluded: [
          {
            provider: 'first',
            model: 'm1',
            actualPriority: 1,
            reason: 'circuit_open',
            circuitCategory: 'raw_provider_secret',
            remainingMs: 999_999_999
          }
        ]
      }
    })

    expect(hop).toMatchObject({
      circuitCategory: 'unknown',
      circuitLabel: '渠道暂时不可用',
      remainingMs: 86_400_000
    })
    expect(formatRelayRecovery(90_000)).toBe('约 1 分 30 秒后可再尝试')
    expect(formatRelayRecovery(null)).toBe('')
  })

  it('marks every hop as budget-blocked when strict budget prevents dispatch', () => {
    const relay = projectRouteRelay({
      ok: true,
      plan: {
        configuredOrder: [
          { provider: 'first', model: 'm1', actualPriority: 1 },
          { provider: 'second', model: 'm2', actualPriority: 2 }
        ],
        dispatchOrder: [],
        excluded: [],
        budget: { status: 'strict_rejected', fallback: 'strict' }
      }
    })

    expect(relay.map((hop) => hop.state)).toEqual(['blocked', 'blocked'])
    expect(relay.map((hop) => hop.reasonLabel)).toEqual(['严格预算阻止发送', '严格预算阻止发送'])
    expect(relay.every((hop) => hop.dispatchPosition === null)).toBe(true)
  })
})
