import { describe, expect, it } from 'vitest'

import {
  normalizeCollaborationSnapshot,
  normalizeTasks,
  type CollaborationSession,
  type CollaborationTask
} from '@/components/collaboration/collaborationModel'
import {
  isTaskFactRecent,
  projectSessionDisposition,
  projectTaskDisposition
} from './workLifecycleProjection'

const NOW = 2_000_000

function session(overrides: Record<string, unknown> = {}): CollaborationSession {
  return normalizeCollaborationSnapshot({
    sessions: [
      {
        id: 'private-session-id',
        surface: 'codex',
        lifecycle: 'active',
        active: true,
        latestActivityAt: NOW - 1_000,
        ...overrides
      }
    ]
  }).sessions[0]
}

function task(status: string, overrides: Record<string, unknown> = {}): CollaborationTask {
  return normalizeTasks({
    tasks: [
      {
        jobId: 'private-job-id',
        source: 'codex',
        status,
        updatedAt: NOW - 1_000,
        ...overrides
      }
    ]
  }).tasks[0]
}

describe('work lifecycle projection', () => {
  it.each(['stopped', 'closed', 'completed', 'cancelled'])(
    'closes terminal session lifecycle %s before active flags',
    (lifecycle) => {
      expect(
        projectSessionDisposition(session({ lifecycle, active: true, requestInFlight: true }), NOW)
      ).toMatchObject({ kind: 'closed' })
    }
  )

  it('retires sessions after five minutes without activity', () => {
    expect(projectSessionDisposition(session(), NOW)).toEqual({
      kind: 'running',
      reason: '协作会话正在运行'
    })
    expect(
      projectSessionDisposition(session({ latestActivityAt: NOW - 5 * 60 * 1_000 - 1 }), NOW)
    ).toMatchObject({ kind: 'closed' })
    expect(projectSessionDisposition(session({ latestActivityAt: 0 }), NOW)).toMatchObject({
      kind: 'closed'
    })
  })

  it('projects verification and warning sessions as attention', () => {
    expect(
      projectSessionDisposition(session({ verification: { blocking: true } }), NOW)
    ).toMatchObject({ kind: 'attention', category: 'blocked' })
    expect(projectSessionDisposition(session({ warning: true }), NOW)).toMatchObject({
      kind: 'attention',
      category: 'blocked'
    })
  })

  it.each([
    ['verification block', { verification: { blocking: true } }],
    ['warning', { warning: true }]
  ])('retires stale %s sessions before attention classification', (_, overrides) => {
    expect(
      projectSessionDisposition(
        session({ ...overrides, latestActivityAt: NOW - 5 * 60 * 1_000 - 1 }),
        NOW
      )
    ).toMatchObject({ kind: 'closed' })
  })

  it.each(['queued', 'running'])('keeps %s tasks running', (status) => {
    expect(projectTaskDisposition(task(status), NOW)).toMatchObject({ kind: 'running' })
  })

  it.each(['queued', 'running'])('retires quiet %s tasks after five minutes', (status) => {
    expect(
      projectTaskDisposition(task(status, { updatedAt: NOW - 5 * 60 * 1_000 - 1 }), NOW)
    ).toMatchObject({ kind: 'closed' })
  })

  it.each(['failed', 'timed_out', 'detached', 'transport_lost'])(
    'keeps %s tasks as attention',
    (status) => {
      expect(projectTaskDisposition(task(status), NOW)).toMatchObject({
        kind: 'attention',
        category: status
      })
    }
  )

  it.each(['failed', 'timed_out', 'detached', 'transport_lost'])(
    'retires stale %s attention tasks after five minutes',
    (status) => {
      expect(
        projectTaskDisposition(task(status, { updatedAt: NOW - 5 * 60 * 1_000 - 1 }), NOW)
      ).toEqual({ kind: 'closed', reason: '任务超过 5 分钟无更新，已退出当前工作' })
    }
  )

  it('keeps an attention task at exactly five minutes in the live desk', () => {
    expect(
      projectTaskDisposition(task('failed', { updatedAt: NOW - 5 * 60 * 1_000 }), NOW)
    ).toMatchObject({ kind: 'attention', category: 'failed' })
  })

  it('shares one five-minute task fact window with recent activity projections', () => {
    expect(isTaskFactRecent(task('succeeded', { updatedAt: NOW - 5 * 60 * 1_000 }), NOW)).toBe(true)
    expect(isTaskFactRecent(task('succeeded', { updatedAt: NOW - 5 * 60 * 1_000 - 1 }), NOW)).toBe(
      false
    )
    expect(isTaskFactRecent(task('running', { updatedAt: 0 }), NOW)).toBe(false)
  })

  it.each(['succeeded', 'cancelled', 'reasoning', 'unknown'])(
    'closes non-live task status %s',
    (status) => {
      expect(projectTaskDisposition(task(status), NOW)).toMatchObject({ kind: 'closed' })
    }
  )

  it('returns stable opaque fingerprints that change with a new failure fact', () => {
    const first = projectTaskDisposition(task('failed'), NOW)
    const again = projectTaskDisposition(task('failed'), NOW)
    const newer = projectTaskDisposition(task('failed', { updatedAt: NOW }), NOW)

    expect(first).toEqual(again)
    expect(first).toMatchObject({ kind: 'attention' })
    if (first.kind !== 'attention' || newer.kind !== 'attention') {
      throw new Error('expected attention dispositions')
    }
    expect(first.fingerprint).toMatch(/^[a-f0-9]{32}$/)
    expect(first.fingerprint).not.toContain('private-job-id')
    expect(newer.fingerprint).not.toBe(first.fingerprint)
    expect(JSON.stringify(first)).not.toContain('private-job-id')
  })
})
