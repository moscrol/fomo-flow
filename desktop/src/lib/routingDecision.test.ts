import { describe, expect, it } from 'vitest'

import { parseRoutingDecisions, topRoutingFactors } from './routingDecision'

describe('routing decision projection', () => {
  it('normalizes unknown input into display-safe routing decisions', () => {
    const [decision] = parseRoutingDecisions({
      decisions: [
        {
          id: 'route-1',
          at: '2026-08-09T08:00:00.000Z',
          model: 'dao-opus-5',
          channelStrategy: 'priority',
          profile: 'unknown',
          candidates: [
            {
              provider: 'primary',
              model: 'm1',
              source: 'primary',
              actualPriority: '1',
              advisoryRank: '2',
              advisoryScore: '0.42',
              factors: { health: 2, cost: -1, latency: 0.5 }
            }
          ],
          outcome: { status: 'selected', provider: 'primary', model: 'm1', actualPriority: 1 },
          budget: { status: 'not_requested' }
        }
      ]
    })

    expect(decision).toMatchObject({
      id: 'route-1',
      model: 'dao-opus-5',
      profile: 'balanced',
      channelStrategy: 'priority',
      outcome: { status: 'selected', provider: 'primary', model: 'm1', actualPriority: 1 },
      budget: { status: 'not_requested', capUsd: null, fallback: null }
    })
    expect(decision.candidates[0]).toMatchObject({
      actualPriority: 1,
      advisoryRank: 2,
      advisoryScore: 0.42,
      factors: { health: 1, cost: 0, latency: 0.5 }
    })
    expect(topRoutingFactors(decision.candidates[0], 2)).toEqual([
      { key: 'health', label: '健康', value: 1 },
      { key: 'latency', label: '延迟', value: 0.5 }
    ])
  })

  it('renders missing numeric and budget fields as unknown values', () => {
    const [decision] = parseRoutingDecisions({
      decisions: [
        {
          id: 'route-unknown',
          candidates: [{}],
          outcome: {},
          budget: {}
        }
      ]
    })

    expect(decision.candidates[0]).toMatchObject({
      actualPriority: null,
      advisoryRank: null,
      advisoryScore: null
    })
    expect(decision.outcome.actualPriority).toBe(null)
    expect(decision.budget).toMatchObject({
      capUsd: null,
      budget_override: null,
      overBudgetFallback: false
    })
  })
})
