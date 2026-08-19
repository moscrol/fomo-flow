import { describe, expect, it } from 'vitest'

import { normalizeCollaborationSnapshot, normalizeTasks } from './collaborationModel'
import { projectChannelCapabilities } from './channelCapabilityModel'

describe('communication channel capability projection', () => {
  it('separates observed source capabilities from upstream route facts', () => {
    const snapshot = normalizeCollaborationSnapshot({
      sessions: [
        {
          id: 'private-codex-session',
          surface: 'codex',
          active: true,
          latestActivityAt: 100,
          workspace: '/Users/private/codex',
          route: { provider: 'cccc', upstreamModel: 'gpt-5.6' }
        },
        {
          id: 'private-devin-host',
          surface: 'devin',
          active: true,
          mode: 'acp-host',
          identityKind: 'native',
          latestActivityAt: 200,
          workspace: '/Users/private/devin',
          route: { provider: 'FOMO FLOW', modelUid: 'dao-opus-5' }
        }
      ]
    })

    const capabilities = projectChannelCapabilities(snapshot, [])

    expect(capabilities.map((item) => item.source)).toEqual(['codex', 'devin', 'acp', 'ide'])
    expect(capabilities.find((item) => item.source === 'codex')).toMatchObject({
      protocol: 'unknown',
      observability: 'available',
      send: 'unavailable',
      approval: 'unavailable',
      handoff: 'available',
      lastSeenAt: 100
    })
    expect(capabilities.find((item) => item.source === 'devin')).toMatchObject({
      protocol: 'acp',
      observability: 'available',
      send: 'available',
      approval: 'available',
      handoff: 'available',
      lastSeenAt: 200
    })
    expect(capabilities.find((item) => item.source === 'ide')).toMatchObject({
      observability: 'unknown',
      send: 'unknown',
      approval: 'unknown',
      handoff: 'unknown',
      lastSeenAt: 0
    })

    const serialized = JSON.stringify(capabilities)
    expect(serialized).not.toMatch(/private-codex-session|private-devin-host/)
    expect(serialized).not.toContain('/Users/private')
    expect(serialized).not.toContain('cccc')
    expect(serialized).not.toContain('gpt-5.6')
  })

  it('keeps external Devin read-only and projects task-only IDE evidence', () => {
    const snapshot = normalizeCollaborationSnapshot({
      sessions: [
        {
          id: 'private-external-devin',
          surface: 'devin',
          active: true,
          mode: 'plugin',
          identityKind: 'derived',
          latestActivityAt: 300
        }
      ]
    })
    const tasks = normalizeTasks({
      tasks: [
        {
          jobId: 'private-ide-task',
          source: 'ide',
          status: 'running',
          updatedAt: 400
        }
      ]
    }).tasks

    const capabilities = projectChannelCapabilities(snapshot, tasks)

    expect(capabilities.find((item) => item.source === 'devin')).toMatchObject({
      protocol: 'unknown',
      observability: 'available',
      send: 'unavailable',
      approval: 'unavailable',
      handoff: 'available'
    })
    expect(capabilities.find((item) => item.source === 'ide')).toMatchObject({
      protocol: 'unknown',
      observability: 'available',
      send: 'unavailable',
      approval: 'unavailable',
      handoff: 'available',
      lastSeenAt: 400
    })
  })
})
