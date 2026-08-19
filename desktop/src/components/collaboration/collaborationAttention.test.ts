import { describe, expect, it } from 'vitest'

import { normalizeCollaborationSnapshot } from './collaborationModel'
import { buildCollaborationAttention } from './collaborationAttention'

describe('collaboration attention queue model', () => {
  it('orders blocked, failed, stale, and in-flight sessions ahead of healthy work', () => {
    const sessions = normalizeCollaborationSnapshot({
      sessions: [
        {
          id: 'healthy',
          surface: 'acp',
          active: true,
          requestInFlight: false,
          lifecycle: 'running',
          latestActivityAt: 9_000,
          goal: '健康会话'
        },
        {
          id: 'watch',
          surface: 'acp',
          active: true,
          requestInFlight: true,
          lifecycle: 'running',
          latestActivityAt: 7_000,
          goal: '等待在途请求',
          phase: '等待上游'
        },
        {
          id: 'stale',
          surface: 'acp',
          active: false,
          stale: true,
          lifecycle: 'recently-ended',
          latestActivityAt: 8_000,
          goal: '检查失联会话',
          phase: '连接心跳'
        },
        {
          id: 'failed',
          surface: 'acp',
          active: true,
          warning: true,
          lifecycle: 'running',
          latestActivityAt: 6_000,
          goal: '审阅失败信号',
          failures: { hasLastError: true, lastToolOk: false }
        },
        {
          id: 'blocked',
          surface: 'acp',
          active: true,
          lifecycle: 'running',
          latestActivityAt: 5_000,
          goal: '处理验证阻塞',
          verification: { status: 'pending', blocking: true }
        }
      ]
    }).sessions

    const items = buildCollaborationAttention(sessions, 10_000)

    expect(items.map((item) => item.kind)).toEqual(['blocked', 'failed', 'stale', 'watch'])
    expect(items.map((item) => item.sessionId)).toEqual(['blocked', 'failed', 'stale', 'watch'])
    expect(items[0]).toMatchObject({
      title: '处理验证阻塞',
      detail: expect.stringContaining('验证阻塞'),
      suggestion: '先检查验证状态，再决定是否交接。',
      tone: 'bad'
    })
  })

  it('sorts same-priority items by activity, caps the queue, and redacts unsafe text', () => {
    const sessions = normalizeCollaborationSnapshot({
      sessions: Array.from({ length: 20 }, (_, index) => ({
        id: `stale-${index}`,
        surface: 'acp',
        active: false,
        stale: true,
        lifecycle: 'recently-ended',
        latestActivityAt: index + 1,
        goal: index === 19 ? 'Bearer secret-token /Users/private/dao' : `失联会话 ${index}`
      }))
    }).sessions

    const items = buildCollaborationAttention(sessions, 10_000)

    expect(items).toHaveLength(12)
    expect(items[0].sessionId).toBe('stale-19')
    expect(items[11].sessionId).toBe('stale-8')
    expect(items[0].title).toBe('[凭据已隐藏] [路径已隐藏]')
    expect(items[0].title).not.toContain('secret-token')
    expect(items[0].title).not.toContain('/Users/private')
  })
})
