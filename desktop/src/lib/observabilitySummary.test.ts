import { describe, expect, it } from 'vitest'

import { summarizeObservability } from './observabilitySummary'

describe('plain-language observability summary', () => {
  it('turns technical snapshots into four conclusion-first cards', () => {
    const summary = summarizeObservability({
      usage: {
        totals: { calls: 10, input: 100, output: 50, total: 150 },
        DeepSeek: { calls: 7, hitRate: 82.5 },
        Claude: { calls: 3, hitRate: 40 }
      },
      alerts: [{ level: 'warning', title: 'Claude slow', detail: 'recent latency' }],
      failures: { stats: { Claude: { total: 2, kinds: { timeout: { count: 2 } } } } },
      traces: [{ durationMs: 1800 }],
      routingDecisions: []
    })

    expect(summary.status.label).toBe('有需要注意的地方')
    expect(summary.cards.map((card) => card.question)).toEqual([
      '现在正常吗？',
      '刚刚发生了什么？',
      '哪个渠道在工作？',
      '要不要处理？'
    ])
    expect(summary.cards[1].detail).toContain('成功 8 次')
    expect(summary.cards[2].headline).toContain('DeepSeek')
    expect(summary.cards[3].detail).toContain('Claude')
    expect(summary.technicalLabels.ttftP95).toBe('最慢的 5% 请求')
    expect(summary.technicalLabels.advisoryScore).toBe('参考分（不改变真实路由）')
  })

  it('returns a safe empty state with a next step', () => {
    const summary = summarizeObservability({
      usage: {},
      alerts: [],
      failures: {},
      traces: [],
      routingDecisions: []
    })

    expect(summary.status.label).toBe('还没有数据')
    expect(summary.status.detail).toContain('发起一轮')
    expect(summary.cards[3].action?.label).toBe('发起一轮请求')
    expect(JSON.stringify(summary)).not.toContain('Authorization')
  })
})
