import { readFile, rename, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'

export type TaskboardWorkStatus = 'blocked' | 'in_progress' | 'in_review'
export type TaskboardPriority = 'none' | 'urgent' | 'high' | 'medium' | 'low'

export type TaskboardWorkItem = {
  identifier: string
  title: string
  status: TaskboardWorkStatus
  priority: TaskboardPriority
  updatedAt: number
}

export type TaskboardSnapshot = {
  state: 'connected' | 'disconnected' | 'unmapped'
  writable: boolean
  message: string
  items: TaskboardWorkItem[]
}

export type PromoteWorkDraft = {
  fingerprint: string
  title: string
  sourceKind: 'session' | 'task'
  failureKind: 'failed' | 'timed_out' | 'detached' | 'transport_lost' | 'stale' | 'blocked'
  acceptance: string
}

export type CreatedTaskboardWork = {
  identifier: string
  title: string
  status: 'todo'
  priority: 'medium'
  updatedAt: number
}

export type TaskboardLocalAdapter = {
  snapshot(): Promise<TaskboardSnapshot>
  selectDescriptor(descriptorPath: string): Promise<TaskboardSnapshot>
  create(draft: PromoteWorkDraft): Promise<CreatedTaskboardWork>
}

type Environment = Record<string, string | undefined>
type LauncherDescriptor = { version: 1; url: URL }

const STATUS_ORDER: Record<TaskboardWorkStatus, number> = {
  blocked: 0,
  in_progress: 1,
  in_review: 2
}
const ALLOWED_STATUS = new Set<TaskboardWorkStatus>(['blocked', 'in_progress', 'in_review'])
const ALLOWED_PRIORITY = new Set<TaskboardPriority>(['none', 'urgent', 'high', 'medium', 'low'])
const THREAD_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,255}$/
const TASK_IDENTIFIER = /^[A-Z][A-Z0-9]{1,30}-[1-9][0-9]{0,11}$/
const WORK_FINGERPRINT = /^[a-f0-9]{32,128}$/
const FAILURE_LABEL: Record<PromoteWorkDraft['failureKind'], string> = {
  failed: '执行失败',
  timed_out: '执行超时',
  detached: '连接中断',
  transport_lost: '连接中断',
  stale: '状态过期',
  blocked: '验证阻塞'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function safeTitle(value: unknown): string {
  const urls: string[] = []
  const protectedText = String(value ?? '')
    .replace(/https?:\/\/[^\s]+/gi, (url) => {
      urls.push(url)
      return `__DAO_URL_${urls.length - 1}__`
    })
    .replace(/\bAuthorization\s*:[^\r\n]*/gi, '[凭据已隐藏]')
    .replace(/\bBearer\s+[^\s,;]+/gi, '[凭据已隐藏]')
    .replace(/\bsk-[A-Za-z0-9_-]+/gi, '[凭据已隐藏]')
    .replace(/\bfile:\/\/\/[^\s]+/gi, '[路径已隐藏]')
    .replace(/(?:^|\s)(?:\/[A-Za-z0-9._~-]+){2,}(?=\s|$)/g, ' [路径已隐藏]')
    .replace(/\b[A-Za-z]:[\\/][^\s]+/g, '[路径已隐藏]')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  const restored = protectedText.replace(
    /__DAO_URL_(\d+)__/g,
    (_match, index) => urls[Number(index)] ?? ''
  )
  return restored.slice(0, 180) || '未命名事项'
}

export function parseTaskboardLauncher(value: unknown): LauncherDescriptor {
  if (!isRecord(value) || value.version !== 1 || typeof value.url !== 'string') {
    throw new Error('Invalid Taskboard launcher')
  }
  let url: URL
  try {
    url = new URL(value.url)
  } catch {
    throw new Error('Invalid Taskboard launcher')
  }
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost'
  if (
    url.protocol !== 'http:' ||
    !loopback ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !url.pathname.split('/').filter(Boolean).length
  ) {
    throw new Error('Invalid Taskboard launcher')
  }
  url.pathname = `${url.pathname.replace(/\/$/, '')}/`
  return { version: 1, url }
}

function disconnected(): TaskboardSnapshot {
  return {
    state: 'disconnected',
    writable: false,
    message: '本地 Taskboard 暂时不可用，实时工作不受影响。',
    items: []
  }
}

function normalizedTimestamp(value: unknown): number {
  const timestamp =
    typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : Number.NaN
  return Number.isFinite(timestamp) && timestamp >= 0 ? timestamp : 0
}

function projectTask(value: unknown): TaskboardWorkItem | null {
  if (!isRecord(value)) return null
  const status = String(value.status ?? '') as TaskboardWorkStatus
  const priority = String(value.priority ?? '') as TaskboardPriority
  const identifier = String(value.identifier ?? '')
  if (
    !ALLOWED_STATUS.has(status) ||
    !ALLOWED_PRIORITY.has(priority) ||
    !TASK_IDENTIFIER.test(identifier)
  ) {
    return null
  }
  return {
    identifier,
    title: safeTitle(value.title),
    status,
    priority,
    updatedAt: normalizedTimestamp(value.updatedAt)
  }
}

export function createTaskboardLocalAdapter({
  userDataDir,
  runtimeRoot,
  environment = process.env,
  fetchImpl = fetch
}: {
  userDataDir: string
  runtimeRoot: string
  environment?: Environment
  fetchImpl?: typeof fetch
}): TaskboardLocalAdapter {
  const configPath = join(userDataDir, 'taskboard-connector.json')
  let selectedPath: string | null = null

  async function configuredPath(): Promise<string | null> {
    if (selectedPath) return selectedPath
    if (environment.CODEX_TASKBOARD_RUNTIME_FILE) {
      selectedPath = environment.CODEX_TASKBOARD_RUNTIME_FILE
      return selectedPath
    }
    try {
      const config = JSON.parse(await readFile(configPath, 'utf8')) as unknown
      if (
        isRecord(config) &&
        config.version === 1 &&
        typeof config.descriptorPath === 'string' &&
        basename(config.descriptorPath) === 'launcher-runtime.json'
      ) {
        selectedPath = config.descriptorPath
        return selectedPath
      }
    } catch {
      // Missing or malformed private config falls through to the dev-local descriptor.
    }
    const developmentPath = join(runtimeRoot, '.taskboard-data', 'launcher-runtime.json')
    try {
      await readFile(developmentPath, 'utf8')
      selectedPath = developmentPath
      return selectedPath
    } catch {
      return null
    }
  }

  async function readJson(url: URL): Promise<unknown> {
    const response = await fetchImpl(url, {
      headers: { accept: 'application/json', 'x-taskboard-client': 'fomo-flow-desktop' },
      signal: AbortSignal.timeout(10_000)
    })
    if (!response.ok) throw new Error(`Taskboard request failed: ${response.status}`)
    return response.json()
  }

  async function projectContext(): Promise<{
    launcher: LauncherDescriptor
    projectId: string
    workspaceName: string
  } | null> {
    const descriptorPath = await configuredPath()
    if (!descriptorPath) return null
    const launcher = parseTaskboardLauncher(JSON.parse(await readFile(descriptorPath, 'utf8')))
    const workspaceRoot = resolve(dirname(dirname(descriptorPath)))
    const projectsPayload = await readJson(new URL('/api/projects', launcher.url))
    const projects =
      isRecord(projectsPayload) && Array.isArray(projectsPayload.projects)
        ? projectsPayload.projects
        : []
    const project = projects.find(
      (value) =>
        isRecord(value) &&
        typeof value.id === 'string' &&
        typeof value.workspacePath === 'string' &&
        resolve(value.workspacePath) === workspaceRoot
    )
    if (!isRecord(project) || typeof project.id !== 'string') return null
    return { launcher, projectId: project.id, workspaceName: basename(workspaceRoot) }
  }

  async function loadSnapshot(): Promise<TaskboardSnapshot> {
    const descriptorPath = await configuredPath()
    if (!descriptorPath) return disconnected()
    try {
      const launcher = parseTaskboardLauncher(JSON.parse(await readFile(descriptorPath, 'utf8')))
      const workspaceRoot = resolve(dirname(dirname(descriptorPath)))
      const projectsPayload = await readJson(new URL('/api/projects', launcher.url))
      const projects =
        isRecord(projectsPayload) && Array.isArray(projectsPayload.projects)
          ? projectsPayload.projects
          : []
      const project = projects.find(
        (value) =>
          isRecord(value) &&
          typeof value.id === 'string' &&
          typeof value.workspacePath === 'string' &&
          resolve(value.workspacePath) === workspaceRoot
      )
      if (!isRecord(project) || typeof project.id !== 'string') {
        return {
          state: 'unmapped',
          writable: false,
          message: '当前仓库尚未映射到本地 Taskboard 项目。',
          items: []
        }
      }
      const tasksUrl = new URL('/api/tasks', launcher.url)
      tasksUrl.searchParams.set('projectId', project.id)
      tasksUrl.searchParams.set('archived', 'false')
      const tasksPayload = await readJson(tasksUrl)
      const tasks =
        isRecord(tasksPayload) && Array.isArray(tasksPayload.tasks) ? tasksPayload.tasks : []
      const items = tasks
        .map(projectTask)
        .filter((item): item is TaskboardWorkItem => item !== null)
        .sort(
          (left, right) =>
            STATUS_ORDER[left.status] - STATUS_ORDER[right.status] ||
            right.updatedAt - left.updatedAt
        )
      const writable = THREAD_ID.test(environment.CODEX_THREAD_ID ?? '')
      return {
        state: 'connected',
        writable,
        message: writable
          ? '已连接本地 Taskboard。'
          : '已连接；加入任务板需要从当前 Codex 任务发起。',
        items
      }
    } catch {
      return disconnected()
    }
  }

  return {
    snapshot: loadSnapshot,
    async selectDescriptor(descriptorPath) {
      if (basename(descriptorPath) !== 'launcher-runtime.json') {
        throw new Error('Invalid Taskboard launcher filename')
      }
      parseTaskboardLauncher(JSON.parse(await readFile(descriptorPath, 'utf8')))
      const temporaryPath = `${configPath}.${process.pid}.tmp`
      await writeFile(temporaryPath, JSON.stringify({ version: 1, descriptorPath }), {
        encoding: 'utf8',
        mode: 0o600
      })
      await rename(temporaryPath, configPath)
      selectedPath = descriptorPath
      return loadSnapshot()
    },
    async create(draft) {
      const threadId = environment.CODEX_THREAD_ID ?? ''
      if (!THREAD_ID.test(threadId)) {
        throw Object.assign(new Error('Current Codex thread attribution is required'), {
          code: 'ATTRIBUTION_REQUIRED'
        })
      }
      const keys = Object.keys(draft)
      if (
        keys.length !== 5 ||
        keys.some(
          (key) =>
            !['fingerprint', 'title', 'sourceKind', 'failureKind', 'acceptance'].includes(key)
        ) ||
        !WORK_FINGERPRINT.test(draft.fingerprint) ||
        !['session', 'task'].includes(draft.sourceKind) ||
        !(draft.failureKind in FAILURE_LABEL) ||
        typeof draft.title !== 'string' ||
        draft.title.length > 180 ||
        typeof draft.acceptance !== 'string' ||
        draft.acceptance.length === 0 ||
        draft.acceptance.length > 220
      ) {
        throw new Error('Invalid Taskboard work draft')
      }
      const context = await projectContext()
      if (!context) throw new Error('Current workspace is not mapped to Taskboard')
      const title = safeTitle(draft.title || 'FOMO FLOW 异常需要处理')
      const acceptance = safeTitle(draft.acceptance)
      const description = [
        `来源：${draft.sourceKind === 'task' ? '任务' : '会话'}`,
        `异常：${FAILURE_LABEL[draft.failureKind]}`,
        `验收：${acceptance}`,
        `工作区：${safeTitle(context.workspaceName)}`
      ].join('\n')
      const response = await fetchImpl(new URL('/api/tasks', context.launcher.url), {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          'x-taskboard-client': 'fomo-flow-desktop'
        },
        body: JSON.stringify({
          projectId: context.projectId,
          title,
          description,
          status: 'todo',
          priority: 'medium',
          labels: ['fomo-flow', 'work-desk'],
          threadId
        }),
        signal: AbortSignal.timeout(15_000)
      })
      if (!response.ok) throw new Error(`Taskboard create failed: ${response.status}`)
      const payload = (await response.json()) as unknown
      const task = isRecord(payload) && isRecord(payload.task) ? payload.task : payload
      if (!isRecord(task) || !TASK_IDENTIFIER.test(String(task.identifier ?? ''))) {
        throw new Error('Invalid Taskboard create response')
      }
      return {
        identifier: String(task.identifier),
        title: safeTitle(task.title),
        status: 'todo',
        priority: 'medium',
        updatedAt: normalizedTimestamp(task.updatedAt)
      }
    }
  }
}
