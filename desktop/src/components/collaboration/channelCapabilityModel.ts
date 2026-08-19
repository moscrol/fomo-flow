import type {
  CollaborationSession,
  CollaborationSnapshot,
  CollaborationTask
} from './collaborationModel'

export type ChannelCapabilityState = 'available' | 'unavailable' | 'unknown'

export type CommunicationSource = 'acp' | 'codex' | 'devin' | 'ide'

export type ChannelCapability = {
  source: CommunicationSource
  label: string
  protocol: 'acp' | 'unknown'
  observability: ChannelCapabilityState
  send: ChannelCapabilityState
  approval: ChannelCapabilityState
  handoff: ChannelCapabilityState
  reason: string
  lastSeenAt: number
}

const SOURCES: Array<{
  source: CommunicationSource
  label: string
}> = [
  { source: 'codex', label: 'Codex' },
  { source: 'devin', label: 'Devin' },
  { source: 'acp', label: 'ACP' },
  { source: 'ide', label: 'IDE' }
]

function normalizedSource(value: unknown): CommunicationSource | null {
  const source = String(value ?? '')
    .trim()
    .toLocaleLowerCase()
  if (source === 'codex' || source === 'devin' || source === 'acp' || source === 'ide') {
    return source
  }
  return null
}

function taskLastSeenAt(task: CollaborationTask): number {
  return Math.max(task.updatedAt, task.lastHeartbeatAt ?? 0, task.result.finishedAt)
}

function observedSessions(
  sessions: CollaborationSession[],
  source: CommunicationSource
): CollaborationSession[] {
  return sessions.filter((session) => session.surface === source)
}

function hasNativeDevinHost(sessions: CollaborationSession[]): boolean {
  return sessions.some(
    (session) =>
      session.surface === 'devin' &&
      session.mode.toLocaleLowerCase() === 'acp-host' &&
      session.identityKind.toLocaleLowerCase() === 'native'
  )
}

/**
 * Projects source-channel capabilities from safe observations only.
 * Upstream provider/model/priority facts intentionally never enter this shape.
 */
export function projectChannelCapabilities(
  snapshot: CollaborationSnapshot,
  tasks: CollaborationTask[]
): ChannelCapability[] {
  const observedRequestTimes = new Map<CommunicationSource, number>()
  for (const request of snapshot.recentRequests) {
    const source = normalizedSource(request.source)
    if (!source) continue
    observedRequestTimes.set(source, Math.max(observedRequestTimes.get(source) ?? 0, request.at))
  }

  const observedTaskTimes = new Map<CommunicationSource, number>()
  for (const task of tasks) {
    const source = normalizedSource(task.source)
    if (!source) continue
    observedTaskTimes.set(
      source,
      Math.max(observedTaskTimes.get(source) ?? 0, taskLastSeenAt(task))
    )
  }

  return SOURCES.map(({ source, label }) => {
    const sessions = observedSessions(snapshot.sessions, source)
    const sessionLastSeenAt = sessions.reduce(
      (latest, session) => Math.max(latest, session.latestActivityAt),
      0
    )
    const lastSeenAt = Math.max(
      sessionLastSeenAt,
      observedRequestTimes.get(source) ?? 0,
      observedTaskTimes.get(source) ?? 0
    )
    const observed = lastSeenAt > 0 || sessions.length > 0

    if (!observed) {
      return {
        source,
        label,
        protocol: 'unknown',
        observability: 'unknown',
        send: 'unknown',
        approval: 'unknown',
        handoff: 'unknown',
        reason: '尚未从本地安全观测源看到这个入口。',
        lastSeenAt: 0
      }
    }

    if (source === 'devin' && hasNativeDevinHost(sessions)) {
      return {
        source,
        label,
        protocol: 'acp',
        observability: 'available',
        send: 'available',
        approval: 'available',
        handoff: 'available',
        reason: '检测到本地 Devin ACP Host，可由 FOMO FLOW 观测并转交人工审批。',
        lastSeenAt
      }
    }

    return {
      source,
      label,
      protocol: 'unknown',
      observability: 'available',
      send: 'unavailable',
      approval: 'unavailable',
      handoff: 'available',
      reason: '已看到入口活动；当前只提供观测和人工交接，不代替入口发送或审批。',
      lastSeenAt
    }
  })
}
