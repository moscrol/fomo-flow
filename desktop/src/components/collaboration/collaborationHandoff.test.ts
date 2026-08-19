import { describe, expect, it } from 'vitest'

import { normalizeCollaborationSnapshot, normalizeTasks } from './collaborationModel'
import { buildSessionHandoff, buildTaskHandoff } from './collaborationHandoff'

describe('collaboration handoff builders', () => {
  it('builds a safe session handoff without secrets, paths, or identifiers', () => {
    const snapshot = normalizeCollaborationSnapshot({
      sessions: [
        {
          id: 'session-private-id',
          surface: 'acp',
          active: true,
          warning: true,
          lifecycle: 'running',
          goal: '交接 Bearer secret-token',
          phase: '执行工具',
          workspace: '/Users/private/dao',
          latestActivityAt: 1_699_999_999_000,
          route: {
            provider: 'bridge',
            modelUid: 'dao-model',
            upstreamModel: 'upstream',
            provisional: false
          },
          todo: { completed: 1, total: 2, current: '整理产物' },
          telemetry: { ttftMs: 420, durationMs: 2_100, modelPath: 'routed', loopSource: 'acp' }
        }
      ],
      recentRequests: [
        {
          id: 'request-private-id',
          at: 1_699_999_998_000,
          source: 'acp',
          provider: 'bridge',
          model: 'upstream',
          status: 'failed',
          errorCategory: 'Bearer another-secret /Users/private/dao',
          success: false,
          attemptCount: 2
        }
      ]
    })

    const content = buildSessionHandoff(
      snapshot.sessions[0],
      snapshot.recentRequests,
      1_700_000_000_000
    )

    expect(content).toContain('# FOMO ACP 会话交接')
    expect(content).toContain('整理产物')
    expect(content).toContain('接手建议')
    expect(content).not.toContain('secret-token')
    expect(content).not.toContain('another-secret')
    expect(content).not.toContain('/Users/private')
    expect(content).not.toContain('session-private-id')
    expect(content).not.toContain('request-private-id')
  })

  it('builds a bounded task handoff with attempts and safe artifacts', () => {
    const { tasks } = normalizeTasks({
      tasks: [
        {
          jobId: 'task-private-id',
          source: 'devin',
          taskType: 'daily-review',
          workspace: '/private/project',
          targetWorkspace: '/private/project',
          commandSummary: 'run --token Bearer secret-token',
          status: 'running',
          phase: '审阅变更',
          progress: '2/4',
          updatedAt: 1_699_999_999_000,
          attempts: Array.from({ length: 8 }, (_, index) => ({
            provider: 'bridge',
            model: 'model',
            fallbackUsed: index > 0,
            fallbackReason: 'fallback-timeout',
            durationMs: 100 + index,
            at: 1_699_999_000_000 + index
          })),
          result: {
            status: 'unknown',
            stdoutSummary: 'safe summary',
            stderrSummary: 'Bearer stderr-secret /private/project',
            artifacts: [{ path: '/private/project/report.html', kind: 'report' }]
          }
        }
      ]
    })

    const content = buildTaskHandoff(tasks[0], 1_700_000_000_000)

    expect(content).toContain('# Dao 协作任务交接')
    expect(content).toContain('fallback')
    expect(content).toContain('report.html')
    expect(content).not.toContain('task-private-id')
    expect(content).not.toContain('secret-token')
    expect(content).not.toContain('stderr-secret')
    expect(content).not.toContain('/private/project/report.html')
    expect((content.match(/fallback-timeout/g) || []).length).toBeLessThanOrEqual(5)
  })
})
