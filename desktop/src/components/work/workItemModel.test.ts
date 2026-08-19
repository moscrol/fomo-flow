import { describe, expect, it } from 'vitest'

import {
  normalizeCollaborationSnapshot,
  normalizeTasks
} from '@/components/collaboration/collaborationModel'
import { sanitizeDisplayText } from './displaySanitizer'
import { buildWorkDesk } from './workItemModel'

describe('work item model', () => {
  it('uses the current todo when a live session has no structured goal', () => {
    const snapshot = normalizeCollaborationSnapshot({
      sessions: [
        {
          id: 'devin-live',
          surface: 'devin',
          active: true,
          latestActivityAt: 10,
          phase: 'editing',
          goal: '',
          todo: { current: 'todo-1: 修复当前工作目标显示' }
        }
      ]
    })

    const desk = buildWorkDesk(snapshot, [], 10)

    expect(desk.active[0].title).toBe('修复当前工作目标显示')
    expect(desk.active[0].title).not.toContain('todo-1')
  })

  it('uses a truthful session label when neither goal nor todo is available', () => {
    const snapshot = normalizeCollaborationSnapshot({
      sessions: [
        {
          id: 'devin-without-goal',
          surface: 'devin',
          active: true,
          latestActivityAt: 10,
          goal: '',
          todo: { current: 'none' }
        }
      ]
    })

    const desk = buildWorkDesk(snapshot, [], 10)

    expect(desk.active[0].title).toBe('Devin 协作会话')
    expect(desk.active[0].title).not.toContain('未识别')
  })

  it('projects safe session and task pulses from existing runtime facts', () => {
    const snapshot = normalizeCollaborationSnapshot({
      sessions: [
        {
          id: 'session-pulse',
          surface: 'devin',
          active: true,
          latestActivityAt: 10,
          goal: '验证当前工作',
          todo: { completed: 1, total: 3, current: 'todo-2: 整理验证结果' },
          failures: { lastToolOk: true }
        },
        {
          id: 'session-blocked',
          surface: 'codex',
          active: true,
          latestActivityAt: 9,
          goal: '等待验证',
          verification: { blocking: true }
        }
      ]
    })
    const tasks = normalizeTasks({
      tasks: [
        {
          jobId: 'task-pulse',
          source: 'acp',
          status: 'running',
          phase: '正在运行',
          progress: '50%',
          updatedAt: 8,
          attempts: [{ provider: 'provider-a', model: 'model-a' }]
        }
      ]
    }).tasks

    const desk = buildWorkDesk(snapshot, tasks, 10)

    expect(desk.active.find((item) => item.target.id === 'session-pulse')?.pulse).toEqual({
      current: '整理验证结果',
      progress: '1 / 3 项完成',
      outcome: '最近工具成功'
    })
    expect(
      desk.attention.find((item) => item.target.id === 'session-blocked')?.pulse?.outcome
    ).toBe('验证需要处理')
    expect(desk.active.find((item) => item.target.id === 'task-pulse')?.pulse).toEqual({
      current: '50%',
      progress: '运行中',
      outcome: '已尝试 1 次'
    })
  })

  it('uses recovery language instead of stale task progress after failure', () => {
    const tasks = normalizeTasks({
      tasks: [
        {
          jobId: 'task-failed-pulse',
          source: 'codex',
          status: 'failed',
          progress: 'Codex task',
          updatedAt: 10
        }
      ]
    }).tasks

    const desk = buildWorkDesk(normalizeCollaborationSnapshot({ sessions: [] }), tasks, 10)

    expect(desk.attention[0].pulse).toEqual({
      current: '等待处理',
      progress: '尚未记录尝试',
      outcome: '需要查看失败原因'
    })
  })

  it('projects normalized sessions and tasks into independent, sorted work buckets', () => {
    const snapshot = normalizeCollaborationSnapshot({
      sessions: [
        {
          id: 'session-blocking',
          surface: 'codex',
          workspace: 'same-workspace',
          goal: '验证阻塞会话',
          phase: '验证中',
          latestActivityAt: 200,
          route: { provider: 'provider-a', upstreamModel: 'model-a' },
          verification: { blocking: true }
        },
        {
          id: 'session-newer',
          surface: 'acp',
          workspace: 'same-workspace',
          goal: '较新告警',
          latestActivityAt: 300,
          warning: true
        },
        {
          id: 'session-stopped',
          surface: 'codex',
          workspace: 'same-workspace',
          lifecycle: 'stopped',
          active: true,
          requestInFlight: true,
          latestActivityAt: 350
        }
      ]
    })
    const tasks = normalizeTasks({
      tasks: [
        {
          jobId: 'task-running',
          source: 'acp',
          workspace: 'same-workspace',
          taskType: '同步',
          status: 'running',
          updatedAt: 250
        },
        {
          jobId: 'task-succeeded',
          source: 'codex',
          workspace: 'same-workspace',
          taskType: '构建',
          status: 'succeeded',
          updatedAt: 100
        }
      ]
    }).tasks

    const desk = buildWorkDesk(snapshot, tasks, 400)

    expect(desk.attention.map((item) => item.target.id)).toEqual([
      'session-newer',
      'session-blocking'
    ])
    expect(desk.attention[1]).toMatchObject({
      kind: 'session',
      bucket: 'attention',
      suggestion: '查看验证阻塞',
      tone: 'bad'
    })
    expect(desk.active[0]).toMatchObject({
      kind: 'task',
      bucket: 'active',
      target: { view: 'tasks', id: 'task-running' }
    })
    expect(desk.active[0].profile).toBe('balanced')
    expect('completed' in desk).toBe(false)
    expect([...desk.attention, ...desk.active].map((item) => item.target.id)).not.toContain(
      'task-succeeded'
    )
    expect([...desk.attention, ...desk.active].map((item) => item.target.id)).not.toContain(
      'session-stopped'
    )
    expect([...desk.attention, ...desk.active]).toHaveLength(3)
  })

  it('sanitizes every presentable field without removing private navigation tokens', () => {
    const secret = 'sk-supersecretvalue'
    const snapshot = normalizeCollaborationSnapshot({
      sessions: [
        {
          id: 'private-session-token',
          surface: 'codex',
          active: true,
          goal: `Bearer session-token ${secret} /Users/private/project`,
          phase: 'C:\\private\\project',
          latestActivityAt: 1,
          route: { provider: 'Bearer provider-token', upstreamModel: '/home/private/model' }
        }
      ]
    })
    const tasks = normalizeTasks({
      tasks: [
        {
          jobId: 'private-task-token',
          source: 'Bearer task-token',
          status: 'failed',
          commandSummary: `failed ${secret} /home/private/task`,
          phase: 'C:\\private\\task',
          updatedAt: 2,
          attempts: [{ provider: '/Users/private/provider', model: `Bearer model-token ${secret}` }]
        }
      ]
    }).tasks

    const desk = buildWorkDesk(snapshot, tasks, 3)
    const items = [...desk.attention, ...desk.active]
    const presentable = items.map(({ source, title, phase, route, routeFacts, suggestion }) => ({
      source,
      title,
      phase,
      route,
      routeFacts,
      suggestion
    }))
    const rendered = JSON.stringify(presentable)

    expect(items.map((item) => item.target.id)).toEqual(
      expect.arrayContaining(['private-session-token', 'private-task-token'])
    )
    expect(rendered).not.toMatch(/Bearer|sk-supersecretvalue|\/Users|\/home|C:\\\\private/i)
  })

  it('preserves partial routes instead of falling back when one route field is absent', () => {
    const snapshot = normalizeCollaborationSnapshot({
      sessions: [
        {
          id: 'session-provider-only',
          surface: 'codex',
          active: true,
          latestActivityAt: 1,
          route: { provider: 'session-provider' }
        }
      ]
    })
    snapshot.sessions[0].route.upstreamModel = ''
    const tasks = normalizeTasks({
      tasks: [
        {
          jobId: 'task-provider-only',
          source: 'acp',
          status: 'running',
          updatedAt: 1,
          attempts: [{ provider: 'task-provider' }]
        }
      ]
    }).tasks
    tasks[0].attempts[0].model = ''

    const desk = buildWorkDesk(snapshot, tasks, 1)

    expect(desk.active.find((item) => item.target.id === 'session-provider-only')?.route).toBe(
      'session-provider'
    )
    expect(desk.active.find((item) => item.target.id === 'task-provider-only')?.route).toBe(
      'task-provider'
    )
  })

  it('keeps safe structured facts for the model that is actually in use', () => {
    const snapshot = normalizeCollaborationSnapshot({
      sessions: [
        {
          id: 'private-model-session',
          surface: 'devin',
          active: true,
          latestActivityAt: 10,
          route: {
            modelUid: 'swe-1-6-slow',
            provider: 'dp',
            upstreamModel: 'deepseek-v4-flash',
            provisional: false
          }
        }
      ]
    })

    const desk = buildWorkDesk(snapshot, [], 10)

    expect(desk.active[0].routeFacts).toEqual({
      modelUid: 'swe-1-6-slow',
      provider: 'dp',
      upstreamModel: 'deepseek-v4-flash',
      provisional: false
    })
  })

  it('preserves ordinary slash text and URLs in presentation fields', () => {
    const snapshot = normalizeCollaborationSnapshot({
      sessions: [
        {
          id: 'session-slashes',
          surface: 'codex',
          active: true,
          latestActivityAt: 1,
          goal: 'openai/gpt-5.6 · build/test · https://api.example.com/v1'
        }
      ]
    })

    const desk = buildWorkDesk(snapshot, [], 1)

    expect(desk.active[0].title).toBe('openai/gpt-5.6 · build/test · https://api.example.com/v1')
  })

  it('redacts Windows paths with either separator while preserving HTTPS URLs', () => {
    const snapshot = normalizeCollaborationSnapshot({
      sessions: [
        {
          id: 'session-windows-paths',
          surface: 'codex',
          active: true,
          latestActivityAt: 1,
          goal: 'C:\\Users\\private\\project C:/Users/private/project https://api.example.com/v1'
        }
      ]
    })

    const desk = buildWorkDesk(snapshot, [], 1)
    const title = desk.active[0].title

    expect(title).not.toContain('C:')
    expect(title).toContain('https://api.example.com/v1')
  })

  it('redacts explicit Unix and file paths without changing URL paths', () => {
    const snapshot = normalizeCollaborationSnapshot({
      sessions: [
        {
          id: 'session-unix-paths',
          surface: 'codex',
          active: true,
          latestActivityAt: 1,
          goal: 'https://api.example.com/home/x https://api.example.com/tmp/x /home/private/x file:///Users/private/x'
        }
      ]
    })

    const desk = buildWorkDesk(snapshot, [], 1)
    const title = desk.active[0].title

    expect(title).toContain('https://api.example.com/home/x')
    expect(title).toContain('https://api.example.com/tmp/x')
    expect(title).not.toContain('/home/private/x')
    expect(title).not.toContain('file:///Users/private/x')
  })

  it('supports model-only routes and falls back only when both route fields are empty', () => {
    const snapshot = normalizeCollaborationSnapshot({
      sessions: [
        {
          id: 'session-model-only',
          surface: 'codex',
          active: true,
          latestActivityAt: 2,
          route: { upstreamModel: 'session-model' }
        },
        {
          id: 'session-empty-route',
          surface: 'codex',
          active: true,
          latestActivityAt: 1,
          route: {}
        }
      ]
    })
    snapshot.sessions[0].route.provider = ''
    snapshot.sessions[1].route.provider = ''
    snapshot.sessions[1].route.upstreamModel = ''
    const tasks = normalizeTasks({
      tasks: [
        {
          jobId: 'task-model-only',
          source: 'acp',
          status: 'running',
          updatedAt: 2,
          attempts: [{ model: 'task-model' }]
        },
        {
          jobId: 'task-empty-route',
          source: 'acp',
          status: 'running',
          updatedAt: 1,
          attempts: [{ provider: 'task-provider', model: 'task-model' }]
        }
      ]
    }).tasks
    tasks[0].attempts[0].provider = ''
    tasks[1].attempts[0].provider = ''
    tasks[1].attempts[0].model = ''

    const desk = buildWorkDesk(snapshot, tasks, 2)

    expect(desk.active.find((item) => item.target.id === 'session-model-only')?.route).toBe(
      'session-model'
    )
    expect(desk.active.find((item) => item.target.id === 'session-empty-route')?.route).toBe(
      '路由待确认'
    )
    expect(desk.active.find((item) => item.target.id === 'task-model-only')?.route).toBe(
      'task-model'
    )
    expect(desk.active.find((item) => item.target.id === 'task-empty-route')?.route).toBe(
      '尚未选择渠道'
    )
  })

  it('redacts all local path roots and authorization schemes in shared display text', () => {
    const rendered = sanitizeDisplayText(
      'Authorization: Basic abc123\n/var/lib/dao /etc/dao /opt/dao /Users/a /home/a /tmp/a file:///var/a C:\\Users\\a C:/Users/a'
    )

    expect(rendered).not.toMatch(/Basic\s+abc123|\/(?:var|etc|opt|Users|home|tmp)\//i)
    expect(rendered).not.toMatch(/C:[\\/]Users[\\/]a/i)
    expect(rendered).toContain('[凭据已隐藏]')
    expect(rendered).toContain('[路径已隐藏]')
  })

  it('redacts complete authorization lines and arbitrary absolute paths while preserving web URLs', () => {
    const credentials = sanitizeDisplayText(
      'Authorization: AWS4-HMAC-SHA256 Credential=AKIA123/20260810 SignedHeaders=host;x-amz-date Signature=secret\n' +
        'Authorization: Custom first-token second-token third-token\nnext line'
    )
    const paths = sanitizeDisplayText(
      '/root/dao /private/var/dao /usr/local/dao /srv/dao /mnt/custom/dao file:///root/dao ' +
        'https://example.com/root/dao http://localhost:8955/private/dao'
    )

    expect(credentials).not.toMatch(/AKIA123|SignedHeaders|Signature|first-token|second-token/i)
    expect(credentials).toContain('next line')
    expect(paths.split('[路径已隐藏]')).toHaveLength(7)
    expect(paths).toContain('https://example.com/root/dao')
    expect(paths).toContain('http://localhost:8955/private/dao')
  })
})
