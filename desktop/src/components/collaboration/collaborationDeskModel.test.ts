import { describe, expect, it } from 'vitest'

import { normalizeCollaborationSnapshot, normalizeTasks } from './collaborationModel'
import { buildCollaborationDesk } from './collaborationDeskModel'

describe('collaboration desk projection', () => {
  it('shows safe agents and leaves tasks unlinked without trusted relation data', () => {
    const snapshot = normalizeCollaborationSnapshot({
      generatedAt: 1,
      sessions: [
        {
          id: 'session-secret',
          surface: 'devin',
          active: true,
          goal: '修复 /Users/a77/private/key.txt',
          phase: '实现',
          workspace: '/Users/a77/workspace-a',
          latestActivityAt: 20,
          route: { provider: 'cccc', upstreamModel: 'dao-opus-5' },
          todo: { current: '继续执行' }
        },
        {
          id: 'codex-secret',
          surface: 'codex',
          active: false,
          goal: '复核结果',
          phase: '验收',
          workspace: '/Users/a77/workspace-b',
          latestActivityAt: 10,
          route: { provider: 'local', upstreamModel: 'gpt-5.6' }
        }
      ],
      providers: [],
      recentRequests: [],
      runtime: { healthy: true, mode: 'desktop', port: 54500, connection: 'local' }
    })
    const { tasks } = normalizeTasks({
      tasks: [
        {
          jobId: 'job-secret',
          taskType: '测试任务',
          phase: '验证',
          status: 'running',
          updatedAt: 30,
          attempts: [{ provider: 'cccc' }, { provider: 'backup' }],
          result: { artifacts: ['/Users/a77/private/result.txt'] }
        }
      ]
    })

    const desk = buildCollaborationDesk(snapshot, tasks)

    expect(desk.agents.map((agent) => agent.label)).toEqual([
      'Devin · workspace-a',
      'Codex · workspace-b'
    ])
    expect(desk.sessionLanes).toHaveLength(2)
    expect(desk.unlinkedTasks).toEqual([
      expect.objectContaining({ title: '测试任务', attemptCount: 2, artifactCount: 1 })
    ])
    expect(desk.links).toEqual([])
    expect(JSON.stringify(desk)).not.toContain('session-secret')
    expect(JSON.stringify(desk)).not.toContain('job-secret')
    expect(JSON.stringify(desk)).not.toContain('/Users/')
  })

  it('bounds every desk lane while preserving source order', () => {
    const snapshot = normalizeCollaborationSnapshot({
      sessions: Array.from({ length: 24 }, (_, index) => ({
        id: `session-${index}`,
        surface: 'acp',
        goal: `会话 ${index}`,
        workspace: `workspace-${index}`
      }))
    })
    const { tasks } = normalizeTasks({
      tasks: Array.from({ length: 24 }, (_, index) => ({
        id: `task-${index}`,
        taskType: `任务 ${index}`,
        updatedAt: 24 - index
      }))
    })

    const desk = buildCollaborationDesk(snapshot, tasks)

    expect(desk.agents).toHaveLength(20)
    expect(desk.sessionLanes).toHaveLength(20)
    expect(desk.unlinkedTasks).toHaveLength(20)
    expect(desk.agents[0]?.label).toBe('ACP · workspace-0')
    expect(desk.unlinkedTasks[0]?.title).toBe('任务 0')
  })

  it('retires stale sessions and codex turns from the live collaboration chain', () => {
    const snapshot = normalizeCollaborationSnapshot({
      sessions: [
        {
          id: 'stale-session',
          surface: 'codex',
          active: true,
          lifecycle: 'running',
          latestActivityAt: 1_000,
          goal: '旧会话'
        }
      ]
    })
    const { tasks } = normalizeTasks({
      tasks: [
        {
          jobId: 'old-turn',
          taskType: 'codex-turn',
          status: 'succeeded',
          phase: 'completed',
          updatedAt: 1_000
        }
      ]
    })

    const desk = buildCollaborationDesk(snapshot, tasks, 301_001)

    expect(desk.sessionLanes).toEqual([])
    expect(desk.unlinkedTasks).toEqual([])
  })

  it('labels codex turns as runtime facts instead of missing task content', () => {
    const { tasks } = normalizeTasks({
      tasks: [{ jobId: 'turn-1', taskType: 'codex-turn', status: 'running', updatedAt: 1 }]
    })

    const desk = buildCollaborationDesk(normalizeCollaborationSnapshot({ sessions: [] }), tasks)

    expect(desk.unlinkedTasks[0]?.title).toBe('Codex turn（仅运行事实）')
  })
})
