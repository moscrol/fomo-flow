import { describe, expect, it } from 'vitest'

import {
  normalizeCollaborationSnapshot,
  normalizeTasks
} from '@/components/collaboration/collaborationModel'
import type { TaskboardWorkItem } from '@/lib/desktopHost'
import type { DecisionInboxItem } from '@/lib/decisionCenter'
import { buildWorkDesk } from './workItemModel'
import { buildWorkCapsule, opaqueWorkOwner, projectDeskEvents } from './deskEventModel'

describe('desk event model', () => {
  it('projects existing safe sources into direct verb object outcome events', () => {
    const now = 1_800_000
    const snapshot = normalizeCollaborationSnapshot({
      generatedAt: now,
      sessions: [
        {
          id: 'private-session',
          surface: 'devin',
          active: true,
          lifecycle: 'running',
          goal: '修复缓存观测',
          phase: '验证中',
          latestActivityAt: now - 1_000,
          route: { provider: 'cccc', upstreamModel: 'gpt-5.6' }
        }
      ],
      recentRequests: [
        {
          id: 'private-request',
          at: now - 2_000,
          source: 'devin',
          provider: 'cccc',
          model: 'gpt-5.6',
          status: 'succeeded',
          success: true,
          cacheStatus: 'hit',
          usageObserved: true
        }
      ]
    })
    const tasks = normalizeTasks({
      tasks: [
        {
          jobId: 'private-job',
          source: 'codex',
          commandSummary: '构建桌面应用',
          status: 'running',
          phase: '执行中',
          updatedAt: now - 3_000
        }
      ]
    }).tasks
    const taskboardItems: TaskboardWorkItem[] = [
      {
        identifier: 'DAOFLOW-7',
        title: 'Buzz 语义层',
        status: 'in_progress',
        priority: 'high',
        updatedAt: now - 4_000
      }
    ]
    const decisions: DecisionInboxItem[] = [
      {
        id: 'decision-0123456789abcdef01234567',
        classification: 'repeated_fallback',
        severity: 'warning',
        title: '缓存命中率下降',
        message: '请查看真实请求证据。',
        status: 'open',
        count: 2,
        lastSeenAt: new Date(now - 500).toISOString(),
        snoozedUntil: null,
        evidenceId: null
      }
    ]

    const events = projectDeskEvents({ snapshot, tasks, taskboardItems, decisions, now })

    expect(
      events.map(({ actor, verb, object, outcome }) => [actor, verb, object, outcome])
    ).toEqual(
      expect.arrayContaining([
        ['Devin', '正在处理', '修复缓存观测', '进行中'],
        ['模型请求', '经过', 'cccc · gpt-5.6', '缓存命中'],
        ['Codex', '正在执行', '构建桌面应用', '运行中'],
        ['Taskboard', '跟踪', 'DAOFLOW-7 · Buzz 语义层', '进行中'],
        ['路由观察', '请求确认', '缓存命中率下降', '需要你确认']
      ])
    )

    const requestEvent = events.find((event) => event.source === 'request')
    const sessionEvent = events.find((event) => event.source === 'session')
    expect(requestEvent?.ownerKey).toBeUndefined()
    expect(requestEvent?.importance).toBe('quiet')
    expect(sessionEvent?.ownerKey).toBe(opaqueWorkOwner('session', 'private-session'))
    expect(JSON.stringify(events)).not.toMatch(/private-session|private-job|private-request/)
  })

  it('redacts display facts, stays bounded, and never guesses request ownership', () => {
    const now = 2_000_000
    const snapshot = normalizeCollaborationSnapshot({
      sessions: [
        {
          id: 'private-devin-a',
          surface: 'devin',
          active: true,
          goal: '读取 /Users/a77/private.txt',
          latestActivityAt: now
        },
        {
          id: 'private-devin-b',
          surface: 'devin',
          active: true,
          goal: 'Authorization: Basic private-token\n验证 C:\\secret\\config.json',
          latestActivityAt: now - 1
        }
      ],
      recentRequests: Array.from({ length: 90 }, (_, index) => ({
        id: `private-request-${index}`,
        at: now - index,
        source: 'devin',
        provider: index === 0 ? 'Bearer private-token' : 'cccc',
        model: index === 0 ? 'sk-live-secret' : 'gpt-5.6',
        status: 'succeeded',
        success: true
      }))
    })

    const events = projectDeskEvents({
      snapshot,
      tasks: [],
      taskboardItems: [],
      decisions: [],
      now
    })
    const serialized = JSON.stringify(events)

    expect(events).toHaveLength(80)
    expect(events[0].at).toBeGreaterThanOrEqual(events[1].at)
    expect(
      events.filter((event) => event.source === 'request').every((event) => !event.ownerKey)
    ).toBe(true)
    expect(serialized).not.toMatch(/private-devin|private-request|private-token|sk-live-secret/)
    expect(serialized).not.toMatch(/\/Users\/a77|C:\\secret/)
    expect(serialized).toContain('[路径已隐藏]')
    expect(serialized).toContain('[凭据已隐藏]')
  })

  it('projects task attempts and artifacts as reliable task-owned events', () => {
    const now = 3_000_000
    const task = normalizeTasks({
      tasks: [
        {
          jobId: 'private-release-job',
          source: 'codex',
          commandSummary: '发布桌面包',
          status: 'succeeded',
          phase: '完成',
          updatedAt: now,
          attempts: [
            {
              provider: 'primary',
              model: 'coder-a',
              errorCategory: 'timeout',
              durationMs: 1_000,
              at: now - 3_000
            },
            {
              provider: 'cccc',
              model: 'gpt-5.6',
              fallbackUsed: true,
              fallbackReason: '首选渠道超时',
              durationMs: 800,
              at: now - 2_000
            }
          ],
          result: {
            status: 'succeeded',
            finishedAt: now,
            stdoutSummary: '构建成功',
            artifacts: [{ ref: '/Users/a77/release/DaoFlow.dmg', kind: '安装包' }]
          }
        }
      ]
    }).tasks[0]

    const events = projectDeskEvents({
      snapshot: normalizeCollaborationSnapshot({ sessions: [] }),
      tasks: [task],
      taskboardItems: [],
      decisions: [],
      now
    })
    const ownerKey = opaqueWorkOwner('task', 'private-release-job')

    expect(
      events.filter((event) => event.ownerKey === ownerKey).map((event) => event.kind)
    ).toEqual(expect.arrayContaining(['task', 'route', 'artifact']))
    expect(events.map(({ verb, object, outcome }) => [verb, object, outcome])).toEqual(
      expect.arrayContaining([
        ['尝试渠道', 'primary · coder-a', '失败 · timeout'],
        ['尝试渠道', 'cccc · gpt-5.6', '使用后备渠道'],
        ['产出', 'DaoFlow.dmg', '可审阅']
      ])
    )
    expect(JSON.stringify(events)).not.toContain('private-release-job')
    expect(JSON.stringify(events)).not.toContain('/Users/a77/release')
  })

  it('builds a capsule from reliable owner events without attaching global requests', () => {
    const now = 4_000_000
    const snapshot = normalizeCollaborationSnapshot({
      sessions: [
        {
          id: 'private-capsule-session',
          surface: 'devin',
          active: true,
          lifecycle: 'running',
          goal: '整理发布验证',
          latestActivityAt: now,
          route: { provider: 'cccc', upstreamModel: 'gpt-5.6' },
          todo: { current: 'todo-2: 整理验证结果', completed: 1, total: 2 }
        }
      ],
      recentRequests: [
        {
          id: 'private-global-request',
          at: now,
          source: 'devin',
          provider: 'cccc',
          model: 'gpt-5.6',
          success: true
        }
      ]
    })
    const item = buildWorkDesk(snapshot, [], now).active[0]
    const events = projectDeskEvents({
      snapshot,
      tasks: [],
      taskboardItems: [],
      decisions: [],
      now
    })

    const capsule = buildWorkCapsule(item, events, undefined, true)

    expect(capsule.current).toBe('整理验证结果')
    expect(capsule.progress).toBe('1 / 2 项完成')
    expect(capsule.events.map((event) => event.source)).toEqual(['session'])
    expect(capsule.events.some((event) => event.source === 'request')).toBe(false)
    expect(capsule.route).toEqual(
      expect.objectContaining({ provider: 'cccc', upstreamModel: 'gpt-5.6' })
    )
    expect(capsule.hasHandoff).toBe(true)
    expect(capsule.task).toBeUndefined()
  })

  it('retains normalized task facts only for the selected task capsule', () => {
    const now = 5_000_000
    const tasks = normalizeTasks({
      tasks: [
        {
          jobId: 'private-capsule-task',
          source: 'codex',
          commandSummary: '构建安装包',
          status: 'running',
          progress: '正在签名',
          updatedAt: now,
          attempts: [{ provider: 'cccc', model: 'gpt-5.6', at: now }]
        }
      ]
    }).tasks
    const snapshot = normalizeCollaborationSnapshot({ sessions: [] })
    const item = buildWorkDesk(snapshot, tasks, now).active[0]
    const events = projectDeskEvents({
      snapshot,
      tasks,
      taskboardItems: [],
      decisions: [],
      now
    })

    const capsule = buildWorkCapsule(item, events, tasks[0], false)

    expect(capsule.task?.commandSummary).toBe('构建安装包')
    expect(capsule.events.map((event) => event.kind)).toEqual(
      expect.arrayContaining(['task', 'route'])
    )
    expect(
      capsule.events.every((event) => event.ownerKey === opaqueWorkOwner('task', item.target.id))
    ).toBe(true)
  })

  it('keeps recent requests but retires session and task events after five minutes', () => {
    const now = 6_000_000
    const snapshot = normalizeCollaborationSnapshot({
      sessions: [
        {
          id: 'private-retired-session',
          surface: 'devin',
          active: true,
          goal: '已退役会话',
          latestActivityAt: now - 5 * 60_000 - 1
        }
      ],
      recentRequests: [
        {
          id: 'private-retained-request',
          at: now - 1_000,
          provider: 'cccc',
          model: 'gpt-5.6',
          success: true
        }
      ]
    })
    const tasks = normalizeTasks({
      tasks: [
        {
          jobId: 'private-retired-task',
          source: 'codex',
          commandSummary: '已退役任务',
          status: 'running',
          updatedAt: now - 5 * 60_000 - 1
        }
      ]
    }).tasks

    const events = projectDeskEvents({ snapshot, tasks, taskboardItems: [], decisions: [], now })

    expect(events.map((event) => event.source)).toEqual(['request'])
    expect(events[0].object).toBe('cccc · gpt-5.6')
  })

  it('uses plain work labels instead of internal unknown-goal placeholders', () => {
    const now = 7_000_000
    const snapshot = normalizeCollaborationSnapshot({
      sessions: [
        {
          id: 'private-unnamed-session',
          surface: 'devin',
          active: true,
          latestActivityAt: now
        }
      ]
    })
    const tasks = normalizeTasks({
      tasks: [
        {
          jobId: 'private-unnamed-task',
          source: 'codex',
          status: 'running',
          updatedAt: now
        }
      ]
    }).tasks

    const events = projectDeskEvents({ snapshot, tasks, taskboardItems: [], decisions: [], now })

    expect(events.find((event) => event.source === 'session')?.object).toBe('Devin 协作会话')
    expect(events.find((event) => event.source === 'task')?.object).toBe('Codex 长任务')
    expect(JSON.stringify(events)).not.toMatch(/未识别任务目标|未提供任务摘要/)
  })

  it('retains high-importance approvals when quiet traffic exceeds the event limit', () => {
    const now = 8_000_000
    const snapshot = normalizeCollaborationSnapshot({
      recentRequests: Array.from({ length: 90 }, (_, index) => ({
        id: `private-traffic-${index}`,
        at: now - index,
        provider: 'cccc',
        model: 'gpt-5.6',
        status: 'succeeded',
        success: true
      }))
    })
    const decisions: DecisionInboxItem[] = [
      {
        id: 'decision-retained-0123456789abcdef',
        classification: 'no_eligible_candidates',
        severity: 'urgent',
        title: '当前没有可用渠道',
        message: '需要人工确认配置。',
        status: 'open',
        count: 1,
        lastSeenAt: new Date(now - 10_000).toISOString(),
        snoozedUntil: null,
        evidenceId: null
      }
    ]

    const events = projectDeskEvents({
      snapshot,
      tasks: [],
      taskboardItems: [],
      decisions,
      now
    })

    expect(events).toHaveLength(80)
    expect(events.some((event) => event.kind === 'approval' && event.importance === 'high')).toBe(
      true
    )
  })

  it('reports unknown task and unattributed attempt facts without guessing success', () => {
    const now = 9_000_000
    const tasks = normalizeTasks({
      tasks: [
        {
          jobId: 'private-unknown-task',
          source: 'codex',
          status: 'mystery',
          updatedAt: now,
          attempts: [{ provider: 'cccc', model: 'gpt-5.6', at: now }]
        }
      ]
    }).tasks

    const events = projectDeskEvents({
      snapshot: normalizeCollaborationSnapshot({}),
      tasks,
      taskboardItems: [],
      decisions: [],
      now
    })

    expect(events.map(({ kind, state, verb, outcome }) => [kind, state, verb, outcome])).toEqual(
      expect.arrayContaining([
        ['task', 'unknown', '状态待确认', '事实类型尚未识别'],
        ['route', 'unknown', '尝试渠道', '已记录尝试']
      ])
    )
  })
})
