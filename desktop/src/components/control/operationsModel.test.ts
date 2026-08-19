import { describe, expect, it } from 'vitest'

import type { DaoDesktopStatus, TaskboardSnapshot } from '@/lib/desktopHost'
import { toHudSnapshot, type HudSnapshot } from './hud/hudProjection'
import { buildOperationsHealth } from './operationsModel'

const status: DaoDesktopStatus = {
  healthy: true,
  running: true,
  port: 54500,
  url: 'http://127.0.0.1:54500',
  profile: 'desktop',
  imported: { config: true, revproxy: false },
  error: null
}

const taskboard: TaskboardSnapshot = {
  state: 'connected',
  writable: false,
  message: '只读连接',
  items: [
    {
      identifier: 'private-taskboard-id',
      title: 'private title',
      status: 'in_progress',
      priority: 'high',
      updatedAt: 12_000
    }
  ]
}

function hud(overrides: Partial<HudSnapshot> = {}): HudSnapshot {
  const base = toHudSnapshot({
    version: 1,
    generatedAt: 10_000,
    runtime: {
      healthy: true,
      port: 54500,
      connection: 'live'
    },
    providers: [
      {
        id: 'private-provider-id',
        state: 'alive',
        ageMs: 1_000,
        model: 'private-model',
        calls: 3,
        recentHitRate: 50,
        latency: {
          overall: { p50TtftMs: 100, p95TtftMs: 300 },
          cache: {
            hit: { p50TtftMs: 90, p95TtftMs: 200 },
            miss: { p50TtftMs: 120, p95TtftMs: 400 }
          }
        },
        circuit: null
      }
    ],
    sessions: [
      {
        id: 'private-session-id',
        surface: 'devin',
        active: true,
        warning: false,
        stale: false,
        latestActivityAt: 9_000
      }
    ],
    recentRequests: [
      {
        id: 'private-request-id',
        at: 9_500,
        provider: 'private-provider',
        model: 'private-model'
      }
    ]
  })
  return {
    ...base,
    ...overrides
  }
}

describe('operations health projection', () => {
  it('projects healthy local operations without exposing raw facts', () => {
    const result = buildOperationsHealth({ now: 12_000, status, hud: hud(), taskboard })

    expect(result.overall).toBe('good')
    expect(result.items.map((item) => item.id)).toEqual([
      'runtime',
      'observation',
      'providers',
      'sessions',
      'requests',
      'taskboard'
    ])
    expect(result.items.find((item) => item.id === 'providers')).toMatchObject({
      tone: 'good',
      count: 1
    })
    expect(result.items.find((item) => item.id === 'taskboard')).toMatchObject({
      tone: 'good',
      count: 1
    })

    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain('private-provider-id')
    expect(serialized).not.toContain('private-session-id')
    expect(serialized).not.toContain('private-request-id')
    expect(serialized).not.toContain('private-model')
    expect(serialized).not.toContain('private title')
  })

  it('distinguishes stale observations and an offline runtime', () => {
    const result = buildOperationsHealth({
      now: 40_000,
      status: { ...status, healthy: false, running: false, error: 'secret /Users/private' },
      hud: hud({ generatedAt: 10_000 }),
      taskboard: { ...taskboard, state: 'disconnected', message: 'private error' }
    })

    expect(result.overall).toBe('bad')
    expect(result.items.find((item) => item.id === 'runtime')).toMatchObject({ tone: 'bad' })
    expect(result.items.find((item) => item.id === 'observation')).toMatchObject({
      tone: 'warn'
    })
    expect(result.items.find((item) => item.id === 'taskboard')).toMatchObject({
      tone: 'warn'
    })
  })

  it('keeps missing data unknown and treats an empty desk as neutral', () => {
    const result = buildOperationsHealth({ now: 12_000, status: null, hud: null, taskboard: null })

    expect(result.overall).toBe('unknown')
    expect(result.items.every((item) => item.tone === 'unknown')).toBe(true)
    expect(result.items.find((item) => item.id === 'requests')?.summary).toContain('暂无')
  })
})
