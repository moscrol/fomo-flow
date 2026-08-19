import type {
  CollaborationSession,
  CollaborationSnapshot,
  CollaborationSurface,
  CollaborationTask
} from './collaborationModel'
import { sanitizeDisplayText } from '@/components/work/displaySanitizer'
import {
  isTaskFactRecent,
  projectSessionDisposition
} from '@/components/work/workLifecycleProjection'

export type CollaborationDeskAgent = {
  key: string
  label: string
  surface: CollaborationSurface
  active: boolean
  phase: string
  model: string
  provider: string
  updatedAt: number
}

export type CollaborationDeskTask = {
  key: string
  title: string
  phase: string
  status: string
  attemptCount: number
  artifactCount: number
  updatedAt: number
}

export type CollaborationDesk = {
  agents: CollaborationDeskAgent[]
  sessionLanes: Array<{
    key: string
    agentKey: string
    goal: string
    current: string
  }>
  unlinkedTasks: CollaborationDeskTask[]
  links: Array<{ from: string; to: string }>
}

const LIMIT = 20

function display(value: unknown, fallback: string, limit = 120): string {
  return sanitizeDisplayText(value, fallback, limit)
}

function taskTitle(task: CollaborationTask): string {
  return task.taskType.toLocaleLowerCase() === 'codex-turn'
    ? 'Codex turn（仅运行事实）'
    : display(task.taskType, '未命名任务', 90)
}

function surfaceName(surface: CollaborationSurface): string {
  return { acp: 'ACP', codex: 'Codex', devin: 'Devin', other: 'Agent' }[surface]
}

function projectAgent(session: CollaborationSession, index: number): CollaborationDeskAgent {
  const key = `agent-${session.surface}-${index}`
  return {
    key,
    label: `${surfaceName(session.surface)} · ${display(session.workspace, '未标记工作区', 80)}`,
    surface: session.surface,
    active: session.active,
    phase: display(session.phase, '未知阶段', 60),
    model: display(session.route.upstreamModel || session.route.modelUid, '未观测模型', 100),
    provider: display(session.route.provider, '未观测渠道', 80),
    updatedAt: session.latestActivityAt
  }
}

export function buildCollaborationDesk(
  snapshot: CollaborationSnapshot,
  tasks: CollaborationTask[],
  now?: number
): CollaborationDesk {
  const currentSessions =
    now === undefined
      ? snapshot.sessions
      : snapshot.sessions.filter(
          (session) => projectSessionDisposition(session, now).kind !== 'closed'
        )
  const currentTasks =
    now === undefined ? tasks : tasks.filter((task) => isTaskFactRecent(task, now))
  const sessions = currentSessions.slice(0, LIMIT)
  const agents = sessions.map(projectAgent)
  const sessionLanes = sessions.map((session, index) => ({
    key: `session-lane-${session.surface}-${index}`,
    agentKey: agents[index]?.key ?? `agent-${index}`,
    goal: display(session.goal, '未识别任务目标'),
    current: display(session.todo.current || session.phase, '暂无结构化进度')
  }))
  const unlinkedTasks = currentTasks.slice(0, LIMIT).map((task, index) => ({
    key: `task-${index}`,
    title: taskTitle(task),
    phase: display(task.phase, '等待阶段', 80),
    status: display(task.status, 'unknown', 40),
    attemptCount: task.attempts.length,
    artifactCount: task.result.artifacts.length,
    updatedAt: task.updatedAt
  }))

  return {
    agents,
    sessionLanes,
    unlinkedTasks,
    links: []
  }
}
