import { describe, expect, it } from 'vitest'

import {
  activityMatchesFilter,
  buildCollaborationActivity,
  formatDuration,
  normalizeCollaborationSnapshot,
  normalizeTasks,
  taskCounts
} from './collaborationModel'

describe('collaboration model normalization', () => {
  it('normalizes a safe session projection', () => {
    const snapshot = normalizeCollaborationSnapshot({
      sessions: [{ id: 's1', surface: 'codex', active: true }]
    })
    expect(snapshot.sessions[0]).toMatchObject({
      id: 's1',
      surface: 'codex',
      active: true,
      warning: false,
      workspace: '未标记工作区'
    })
  })

  it('does not treat a continuation wrapper as the session goal', () => {
    const snapshot = normalizeCollaborationSnapshot({
      sessions: [
        {
          id: 's-wrapper',
          surface: 'devin',
          goal: 'You are continuing work from a previous conversation thread. Below is a summary of the previous conversation thread:'
        }
      ]
    })

    expect(snapshot.sessions[0]?.goal).toBe('未识别任务目标')
  })

  it('projects provider latency samples without turning missing values into zero', () => {
    const snapshot = normalizeCollaborationSnapshot({
      providers: [
        {
          id: 'bridge',
          latency: {
            overall: { p50TtftMs: 380, p95TtftMs: 720 },
            cache: { hit: { p95TtftMs: 180 }, miss: { p95TtftMs: 420 } }
          }
        },
        { id: 'empty-provider' }
      ]
    })

    expect(snapshot.providers[0]).toEqual({
      id: 'bridge',
      latency: {
        overall: { p50TtftMs: 380, p95TtftMs: 720 },
        cache: {
          hit: { p50TtftMs: null, p95TtftMs: 180 },
          miss: { p50TtftMs: null, p95TtftMs: 420 }
        }
      }
    })
    expect(snapshot.providers[1].latency.overall).toEqual({ p50TtftMs: null, p95TtftMs: null })
  })

  it('normalizes task attempts and hides full artifact paths', () => {
    const result = normalizeTasks({
      tasks: [
        {
          jobId: 'j1',
          status: 'running',
          attempts: [{ provider: 'p1' }],
          result: { artifacts: [{ path: '/secret/full/path' }] }
        }
      ]
    })
    expect(result.tasks[0]).toMatchObject({
      jobId: 'j1',
      status: 'running',
      attempts: [{ provider: 'p1' }]
    })
    expect(result.tasks[0].result.artifacts[0]).toEqual({ ref: 'path', kind: '' })
    expect(result.counts).toMatchObject({ total: 1, running: 1 })
  })

  it('keeps malformed payloads renderable and formats durations', () => {
    expect(normalizeTasks({ tasks: 'bad' }).tasks).toEqual([])
    expect(taskCounts([]).total).toBe(0)
    expect(formatDuration(null)).toBe('—')
    expect(formatDuration(850)).toBe('850 ms')
    expect(formatDuration(2_500)).toBe('2.5 s')
  })

  it('projects semantic activity and keeps raw fields safe', () => {
    const snapshot = normalizeCollaborationSnapshot({
      sessions: [
        {
          id: 'session-safe',
          surface: 'acp',
          active: true,
          requestInFlight: true,
          lifecycle: 'running',
          goal: '交接 Bearer super-secret',
          phase: '执行工具',
          workspace: '/Users/private/dao',
          latestActivityAt: 100,
          route: {
            modelUid: 'dao-model',
            provider: 'bridge',
            upstreamModel: 'upstream',
            provisional: false
          },
          todo: { completed: 1, total: 2, current: '检查产物' },
          verification: { status: 'passed', blocking: false }
        }
      ],
      recentRequests: [
        {
          id: 'request-safe',
          at: 90,
          source: 'acp',
          provider: 'bridge',
          model: 'upstream',
          status: 'succeeded',
          success: true,
          responseToolCount: 2,
          firstSignalKind: 'tool',
          cacheStatus: 'hit',
          attemptCount: 2,
          errorCategory: 'Bearer another-secret /Users/private/dao'
        }
      ]
    })

    const items = buildCollaborationActivity(snapshot.sessions[0], snapshot.recentRequests)
    expect(items.some((item) => item.kind === 'tool' && item.outcome === '2 次工具信号')).toBe(true)
    expect(items.some((item) => item.kind === 'result' && item.outcome === '成功')).toBe(true)
    const serialized = JSON.stringify(items)
    expect(serialized).not.toContain('super-secret')
    expect(serialized).not.toContain('another-secret')
    expect(serialized).not.toContain('/Users/private/dao')
    expect(activityMatchesFilter(items[0], 'all')).toBe(true)
  })

  it('coalesces adjacent identical request events and caps the feed', () => {
    const session = normalizeCollaborationSnapshot({
      sessions: [
        {
          id: 'session-repeat',
          surface: 'acp',
          active: true,
          lifecycle: 'running',
          latestActivityAt: 300,
          route: { provider: 'bridge', upstreamModel: 'model' }
        }
      ]
    }).sessions[0]
    const requests = normalizeCollaborationSnapshot({
      recentRequests: Array.from({ length: 100 }, (_, index) => ({
        id: `request-${index}`,
        at: index + 1,
        source: 'acp',
        provider: 'bridge',
        model: 'model',
        status: 'observed'
      }))
    }).recentRequests
    const items = buildCollaborationActivity(session, requests)
    expect(items.length).toBeLessThanOrEqual(80)
    expect(items.some((item) => item.repeatCount > 1)).toBe(true)
    expect(items.filter((item) => item.kind === 'result').length).toBeGreaterThan(0)
    expect(items.filter((item) => item.kind === 'lifecycle').length).toBe(1)
  })

  it('does not guess a session request relation from a shared provider or model', () => {
    const snapshot = normalizeCollaborationSnapshot({
      sessions: [
        {
          id: 'session-a',
          surface: 'acp',
          route: { provider: 'cccc', upstreamModel: 'dao-opus-5' }
        }
      ],
      recentRequests: [
        {
          id: 'request-from-codex',
          source: 'codex',
          provider: 'cccc',
          model: 'dao-opus-5',
          success: true
        }
      ]
    })

    const items = buildCollaborationActivity(snapshot.sessions[0], snapshot.recentRequests)

    expect(items.some((item) => item.turnId === 'request-from-codex')).toBe(false)
  })
})
