import { describe, expect, it } from 'vitest'

import { cacheLine, capabilityBadges, formatTokens, healthState, usageLine } from './controlDisplay'

describe('control display projections', () => {
  it('keeps empty usage readable instead of inventing zero samples', () => {
    expect(usageLine({})).toBe('尚无真实请求')
    expect(cacheLine({})).toBe('缓存暂无样本')
  })

  it('formats runtime counters and capability badges', () => {
    expect(formatTokens(1_050_000)).toBe('1.05M')
    expect(
      capabilityBadges({
        supportsThinking: true,
        reasoningLevels: ['off', 'high'],
        supportsTools: true,
        contextTokens: 200_000
      })
    ).toEqual(['思考 2 档', '工具兼容', '上下文 200K'])
  })

  it('maps health snapshots to stable tones', () => {
    expect(healthState({ alive: true })).toEqual({ label: '已连通', tone: 'good' })
    expect(healthState({ alive: false })).toEqual({ label: '探活失败', tone: 'bad' })
    expect(healthState({}, true)).toEqual({ label: '内置验证通路', tone: 'good' })
  })
})
