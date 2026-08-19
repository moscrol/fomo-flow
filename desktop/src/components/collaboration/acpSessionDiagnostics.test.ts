import { describe, expect, it } from 'vitest'

import { normalizeCollaborationSnapshot } from './collaborationModel'
import { buildAcpSessionDiagnostics } from './acpSessionDiagnostics'

describe('ACP session diagnostic facts', () => {
  it('builds ordered facts and risk tones from a complete projection', () => {
    const snapshot = normalizeCollaborationSnapshot({
      sessions: [
        {
          id: 'session-diagnostics',
          surface: 'acp',
          active: true,
          stale: false,
          warning: true,
          mode: 'auto',
          identityKind: 'derived',
          lifecycle: 'running',
          latestActivityAt: 9_000,
          route: { provider: 'bridge', upstreamModel: 'claude-opus' },
          verification: { status: 'pending', blocking: true },
          failures: { maxConsecutive: 2, sameCallStreak: 1, lastToolOk: false, hasLastError: true },
          telemetry: { reasoningTokens: 12_000, ttftMs: 420, durationMs: 2_100, compactions: 3 },
          cache: { observed: true, calls: 4, cached: 1_200, cacheWrite: 300, hitRate: 40 },
          todo: { completed: 1, total: 3, current: '整理产物' }
        }
      ],
      providers: [
        {
          id: 'bridge',
          latency: {
            overall: { p50TtftMs: 380, p95TtftMs: 720 },
            cache: { hit: { p95TtftMs: 180 }, miss: { p95TtftMs: 420 } }
          }
        }
      ]
    })

    const facts = buildAcpSessionDiagnostics(snapshot.sessions[0], snapshot.providers[0], 10_000)

    expect(facts.map((fact) => fact.label)).toEqual([
      '验证',
      '失败信号',
      '会话缓存',
      '新鲜度',
      '推理 Token',
      '首字延迟',
      '轮次耗时',
      '渠道 TTFT P50',
      '渠道 TTFT P95',
      '缓存命中 P95',
      '缓存未命中 P95',
      '上下文压缩',
      '模型路径',
      '状态来源'
    ])
    expect(facts.find((fact) => fact.label === '验证')).toMatchObject({
      value: 'PENDING',
      note: '存在完成阻塞',
      tone: 'bad'
    })
    expect(facts.find((fact) => fact.label === '失败信号')).toMatchObject({
      value: '2 MAX · 1 REPEAT',
      note: '最近工具失败',
      tone: 'bad'
    })
    expect(facts.find((fact) => fact.label === '推理 Token')?.value).toBe('1.2万')
    expect(facts.find((fact) => fact.label === '渠道 TTFT P95')?.value).toBe('720 ms')
    expect(facts.find((fact) => fact.label === '缓存未命中 P95')?.value).toBe('420 ms')
  })

  it('keeps missing samples explicit and does not infer success', () => {
    const session = normalizeCollaborationSnapshot({
      sessions: [
        {
          id: 'session-empty',
          surface: 'acp',
          lifecycle: 'unknown',
          latestActivityAt: 0,
          verification: { status: 'unknown', blocking: false },
          failures: { lastToolOk: null },
          cache: { observed: false }
        }
      ]
    }).sessions[0]

    const facts = buildAcpSessionDiagnostics(session, undefined, 10_000)

    expect(facts.find((fact) => fact.label === '验证')).toMatchObject({
      value: 'UNKNOWN',
      tone: 'muted'
    })
    expect(facts.find((fact) => fact.label === '会话缓存')?.value).toBe('—')
    expect(facts.find((fact) => fact.label === '渠道 TTFT P95')?.value).toBe('—')
    expect(facts.find((fact) => fact.label === '失败信号')?.note).toBe('工具状态未知')
  })
})
