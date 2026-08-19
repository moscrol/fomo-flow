import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { createTaskboardLocalAdapter, parseTaskboardLauncher } from './taskboard-local'

const created: string[] = []

async function fixture(): Promise<{
  root: string
  userDataDir: string
  descriptorPath: string
}> {
  const root = await mkdtemp(join(tmpdir(), 'dao-taskboard-'))
  created.push(root)
  const workspace = join(root, 'dao-proxy-pro')
  const userDataDir = join(root, 'user-data')
  const descriptorPath = join(workspace, '.taskboard-data', 'launcher-runtime.json')
  await mkdir(dirname(descriptorPath), { recursive: true })
  await mkdir(userDataDir, { recursive: true })
  await writeFile(
    descriptorPath,
    JSON.stringify({ version: 1, pid: 123, url: 'http://127.0.0.1:47823/private-challenge' })
  )
  return { root, userDataDir, descriptorPath }
}

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(created.splice(0).map((directory) => rm(directory, { recursive: true })))
})

describe('local Taskboard adapter', () => {
  it('accepts only versioned loopback HTTP challenge launchers', () => {
    expect(
      parseTaskboardLauncher({
        version: 1,
        url: 'http://127.0.0.1:47823/private-challenge'
      }).url.origin
    ).toBe('http://127.0.0.1:47823')

    for (const url of [
      'https://127.0.0.1/private-challenge',
      'http://example.com/private-challenge',
      'http://user:pass@127.0.0.1/private-challenge',
      'http://127.0.0.1/private-challenge?token=x',
      'http://127.0.0.1/private-challenge#token',
      'http://127.0.0.1/'
    ]) {
      expect(() => parseTaskboardLauncher({ version: 1, url })).toThrow('launcher')
    }
    expect(() => parseTaskboardLauncher({ version: 2, url: 'http://127.0.0.1/x' })).toThrow(
      'launcher'
    )
  })

  it('maps the descriptor workspace and returns only safe open work projection', async () => {
    const { userDataDir, descriptorPath } = await fixture()
    const workspace = dirname(dirname(descriptorPath))
    const requested: string[] = []
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = String(input)
      requested.push(url)
      if (url.endsWith('/api/projects')) {
        return Response.json({
          projects: [
            { id: 'other', workspacePath: '/private/other' },
            { id: 'fomo-flow', workspacePath: workspace }
          ]
        })
      }
      if (url.includes('/api/tasks?')) {
        return Response.json({
          tasks: [
            {
              id: 'private-task-uuid',
              identifier: 'DAOFLOW-3',
              title: '待验收事项',
              status: 'in_review',
              priority: 'medium',
              updatedAt: '2026-08-10T03:00:00.000Z',
              threadId: 'private-thread-id'
            },
            {
              id: 'private-task-uuid-2',
              identifier: 'DAOFLOW-2',
              title: 'Authorization: Basic secret\n阻塞事项 /Users/private/repo',
              status: 'blocked',
              priority: 'high',
              updatedAt: '2026-08-10T05:00:00.000Z'
            },
            {
              identifier: 'DAOFLOW-1',
              title: '进行事项',
              status: 'in_progress',
              priority: 'urgent',
              updatedAt: '2026-08-10T04:00:00.000Z'
            },
            {
              identifier: 'DAOFLOW-4',
              title: '已完成事项',
              status: 'done',
              priority: 'low',
              updatedAt: '2026-08-10T06:00:00.000Z'
            }
          ]
        })
      }
      return new Response('not found', { status: 404 })
    })
    const adapter = createTaskboardLocalAdapter({
      userDataDir,
      runtimeRoot: workspace,
      environment: { CODEX_TASKBOARD_RUNTIME_FILE: descriptorPath },
      fetchImpl
    })

    const snapshot = await adapter.snapshot()

    expect(snapshot).toMatchObject({ state: 'connected', writable: false })
    expect(snapshot.items.map((item) => item.identifier)).toEqual([
      'DAOFLOW-2',
      'DAOFLOW-1',
      'DAOFLOW-3'
    ])
    expect(snapshot.items[0].title).toContain('阻塞事项')
    expect(snapshot.items[0].title).not.toMatch(/Basic secret|\/Users\/private/)
    expect(JSON.stringify(snapshot)).not.toMatch(
      /private-challenge|private-task-uuid|private-thread-id|dao-proxy-pro/
    )
    expect(requested).toHaveLength(2)
    expect(requested[0]).toBe('http://127.0.0.1:47823/api/projects')
    expect(requested[1]).toContain('/api/tasks?projectId=fomo-flow&archived=false')
    expect(requested.join('\n')).not.toContain('/private-challenge/api/')
  })

  it('persists a validated explicit descriptor path without returning it', async () => {
    const { userDataDir, descriptorPath } = await fixture()
    const workspace = dirname(dirname(descriptorPath))
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      if (String(input).endsWith('/api/projects')) {
        return Response.json({ projects: [{ id: 'fomo-flow', workspacePath: workspace }] })
      }
      return Response.json({ tasks: [] })
    })
    const adapter = createTaskboardLocalAdapter({
      userDataDir,
      runtimeRoot: join(userDataDir, 'missing-runtime'),
      environment: {},
      fetchImpl
    })

    const snapshot = await adapter.selectDescriptor(descriptorPath)

    expect(snapshot.state).toBe('connected')
    expect(JSON.stringify(snapshot)).not.toContain(descriptorPath)
    const config = await readFile(join(userDataDir, 'taskboard-connector.json'), 'utf8')
    expect(JSON.parse(config)).toEqual({ version: 1, descriptorPath })
  })

  it('returns unmapped and disconnected states without guessing a project', async () => {
    const { userDataDir, descriptorPath } = await fixture()
    const unmapped = createTaskboardLocalAdapter({
      userDataDir,
      runtimeRoot: dirname(dirname(descriptorPath)),
      environment: { CODEX_TASKBOARD_RUNTIME_FILE: descriptorPath },
      fetchImpl: vi.fn(async (input) =>
        String(input).endsWith('/api/projects')
          ? Response.json({ projects: [{ id: 'other', workspacePath: '/private/other' }] })
          : Response.json({ tasks: [] })
      )
    })
    expect(await unmapped.snapshot()).toEqual({
      state: 'unmapped',
      writable: false,
      message: '当前仓库尚未映射到本地 Taskboard 项目。',
      items: []
    })

    const disconnected = createTaskboardLocalAdapter({
      userDataDir,
      runtimeRoot: dirname(dirname(descriptorPath)),
      environment: { CODEX_TASKBOARD_RUNTIME_FILE: descriptorPath },
      fetchImpl: vi.fn(async () => {
        throw new Error('offline')
      })
    })
    expect(await disconnected.snapshot()).toEqual({
      state: 'disconnected',
      writable: false,
      message: '本地 Taskboard 暂时不可用，实时工作不受影响。',
      items: []
    })
  })

  it('does not write without a real current Codex thread attribution', async () => {
    const { userDataDir, descriptorPath } = await fixture()
    const workspace = dirname(dirname(descriptorPath))
    const fetchImpl = vi.fn<typeof fetch>(async (input) =>
      String(input).endsWith('/api/projects')
        ? Response.json({ projects: [{ id: 'fomo-flow', workspacePath: workspace }] })
        : Response.json({ tasks: [] })
    )
    const adapter = createTaskboardLocalAdapter({
      userDataDir,
      runtimeRoot: workspace,
      environment: { CODEX_TASKBOARD_RUNTIME_FILE: descriptorPath },
      fetchImpl
    })

    await expect(
      adapter.create({
        fingerprint: '0'.repeat(32),
        title: '构建失败',
        sourceKind: 'task',
        failureKind: 'failed',
        acceptance: '修复后完成一次验证。'
      })
    ).rejects.toMatchObject({ code: 'ATTRIBUTION_REQUIRED' })
    expect(fetchImpl.mock.calls.some(([, init]) => init?.method?.toUpperCase() === 'POST')).toBe(
      false
    )
  })

  it('creates one exact safe todo only after attributed confirmation', async () => {
    const { userDataDir, descriptorPath } = await fixture()
    const workspace = dirname(dirname(descriptorPath))
    const requests: Array<{ url: string; init?: RequestInit }> = []
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input)
      requests.push({ url, init })
      if (url.endsWith('/api/projects')) {
        return Response.json({ projects: [{ id: 'fomo-flow', workspacePath: workspace }] })
      }
      if (init?.method === 'POST') {
        return Response.json({
          task: {
            identifier: 'DAOFLOW-8',
            title: 'FOMO FLOW 异常需要处理',
            status: 'todo',
            priority: 'medium',
            updatedAt: '2026-08-10T05:00:00.000Z',
            id: 'private-created-uuid'
          }
        })
      }
      return Response.json({ tasks: [] })
    })
    const adapter = createTaskboardLocalAdapter({
      userDataDir,
      runtimeRoot: workspace,
      environment: {
        CODEX_TASKBOARD_RUNTIME_FILE: descriptorPath,
        CODEX_THREAD_ID: '019fe1df-629c-7ed1-9035-92c56fe39520'
      },
      fetchImpl
    })

    const createdTask = await adapter.create({
      fingerprint: '0'.repeat(32),
      title: '',
      sourceKind: 'task',
      failureKind: 'transport_lost',
      acceptance: '确认连接恢复并完成一次验证。'
    })

    expect(createdTask).toEqual({
      identifier: 'DAOFLOW-8',
      title: 'FOMO FLOW 异常需要处理',
      status: 'todo',
      priority: 'medium',
      updatedAt: Date.parse('2026-08-10T05:00:00.000Z')
    })
    expect(JSON.stringify(createdTask)).not.toMatch(/private-created-uuid|private-challenge/)
    const post = requests.find((request) => request.init?.method === 'POST')
    expect(post?.url).toBe('http://127.0.0.1:47823/api/tasks')
    expect(JSON.parse(String(post?.init?.body))).toEqual({
      projectId: 'fomo-flow',
      title: 'FOMO FLOW 异常需要处理',
      description:
        '来源：任务\n异常：连接中断\n验收：确认连接恢复并完成一次验证。\n工作区：dao-proxy-pro',
      status: 'todo',
      priority: 'medium',
      labels: ['fomo-flow', 'work-desk'],
      threadId: '019fe1df-629c-7ed1-9035-92c56fe39520'
    })
  })
})
