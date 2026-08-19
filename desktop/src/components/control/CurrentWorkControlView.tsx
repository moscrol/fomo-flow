import { useEffect, useMemo, useRef, useState } from 'react'

import { asRecord } from '@/lib/daoControlApi'
import {
  normalizeCollaborationSnapshot,
  normalizeTasks,
  formatRelativeAge
} from '@/components/collaboration/collaborationModel'
import {
  buildWorkDesk,
  emptyWorkDesk,
  type WorkDesk,
  type WorkItem
} from '@/components/work/workItemModel'
import { buildWorkCapsule, projectDeskEvents } from '@/components/work/deskEventModel'
import {
  buildInterventionSummary,
  type InterventionSummary
} from '@/components/work/workItemInterventionModel'
import { projectDecisionInbox, type DecisionInboxItem } from '@/lib/decisionCenter'
import { WorkItemInterventionPanel } from './WorkItemInterventionPanel'
import { WorkItemArtifactPanel } from './WorkItemArtifactPanel'
import type {
  CollaborationSnapshot,
  CollaborationTask
} from '@/components/collaboration/collaborationModel'
import {
  ControlListEmpty,
  ControlPanel,
  ControlStatus,
  ControlView,
  ActionButton,
  LoadingState,
  useDaoApi
} from './ControlPrimitives'
import type { DaoViewId } from '@/lib/views'
import { desktopHost, type PromoteWorkDraft, type TaskboardSnapshot } from '@/lib/desktopHost'
import { TaskboardWorkPanel } from './TaskboardWorkPanel'
import { PromoteWorkDialog } from './PromoteWorkDialog'
import { DeskActivityFeed } from './DeskActivityFeed'
import { WorkCapsulePanel } from './WorkCapsulePanel'

const EMPTY_LABELS: Record<keyof WorkDesk, string> = {
  attention: '目前没有需要你处理的异常。',
  active: '目前没有 Agent 正在运行。'
}

const EMPTY_TASKBOARD: TaskboardSnapshot = {
  state: 'disconnected',
  writable: false,
  message: '本地 Taskboard 暂时不可用，实时工作不受影响。',
  items: []
}

const EMPTY_COLLABORATION_SNAPSHOT = normalizeCollaborationSnapshot({})

type WorkObservationSummary = {
  sourcePort: number | null
  sessions: number
  tasks: number
  retired: number
}

export function CurrentWorkControlView({
  onOpenItem,
  onNavigate
}: {
  onOpenItem(item: WorkItem): void
  onNavigate?: (view: DaoViewId) => void
}) {
  const api = useDaoApi()
  const [desk, setDesk] = useState<WorkDesk>(() => emptyWorkDesk())
  const [observation, setObservation] = useState<WorkObservationSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [now, setNow] = useState(() => Date.now())
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [collaborationSnapshot, setCollaborationSnapshot] = useState<CollaborationSnapshot>(
    EMPTY_COLLABORATION_SNAPSHOT
  )
  const [tasks, setTasks] = useState<CollaborationTask[]>([])
  const [decisions, setDecisions] = useState<DecisionInboxItem[]>([])
  const [decisionNotice, setDecisionNotice] = useState('')
  const [interventionSummary, setInterventionSummary] = useState<InterventionSummary | null>(null)
  const [handoff, setHandoff] = useState('')
  const [interventionLoading, setInterventionLoading] = useState(false)
  const [interventionStatus, setInterventionStatus] = useState('')
  const [actionStatus, setActionStatus] = useState('')
  const [actionLoading, setActionLoading] = useState(false)
  const [taskboardSnapshot, setTaskboardSnapshot] = useState<TaskboardSnapshot>(EMPTY_TASKBOARD)
  const [taskboardLoading, setTaskboardLoading] = useState(true)
  const [promoteDraft, setPromoteDraft] = useState<PromoteWorkDraft | null>(null)
  const [promoteLoading, setPromoteLoading] = useState(false)
  const [promoteStatus, setPromoteStatus] = useState('')
  const refreshSeq = useRef(0)
  const interventionSeq = useRef(0)
  const taskboardSeq = useRef(0)
  const locallyResolved = useRef(new Set<string>())

  const deskEvents = useMemo(
    () =>
      projectDeskEvents({
        snapshot: collaborationSnapshot,
        tasks,
        taskboardItems: taskboardSnapshot.items,
        decisions,
        now
      }),
    [collaborationSnapshot, decisions, now, taskboardSnapshot.items, tasks]
  )
  const tasksById = useMemo(
    () => Object.fromEntries(tasks.map((task) => [task.jobId, task])),
    [tasks]
  )
  const selectedItem = useMemo(
    () =>
      selectedKey
        ? ([...desk.attention, ...desk.active].find((item) => item.key === selectedKey) ?? null)
        : null,
    [desk, selectedKey]
  )
  const selectedTask = selectedItem?.kind === 'task' ? tasksById[selectedItem.target.id] : undefined
  const selectedCapsule = selectedItem
    ? buildWorkCapsule(selectedItem, deskEvents, selectedTask, Boolean(handoff.trim()))
    : null

  async function refresh(): Promise<void> {
    const seq = ++refreshSeq.current
    const isCurrent = () => seq === refreshSeq.current
    setError('')
    setNotice('')
    try {
      const [hudPayload, tasksResult, decisionsResult] = await Promise.all([
        api.request('/origin/hud/snapshot'),
        api
          .request('/origin/tasks')
          .then((payload) => ({ ok: true as const, payload }))
          .catch(() => ({ ok: false as const, payload: null })),
        api
          .request('/origin/ea/decision-inbox?limit=50')
          .then((payload) => ({ ok: true as const, payload }))
          .catch(() => ({ ok: false as const, payload: null }))
      ])
      if (!isCurrent()) return
      const snapshot = normalizeCollaborationSnapshot(hudPayload)
      let nextTasks
      let nextNotice = ''
      if (tasksResult.ok) {
        nextTasks = normalizeTasks(tasksResult.payload).tasks
      } else {
        if (!isCurrent()) return
        nextTasks = normalizeTasks({ tasks: asRecord(hudPayload).tasks }).tasks
        nextNotice = '任务详情接口暂不可用，当前显示 HUD 摘要。'
      }
      const nextDecisions = decisionsResult.ok ? projectDecisionInbox(decisionsResult.payload) : []
      const nextDesk = buildWorkDesk(snapshot, nextTasks)
      const fingerprints = nextDesk.attention.flatMap((item) =>
        item.fingerprint ? [item.fingerprint] : []
      )
      let resolved: string[] = []
      try {
        resolved = (await desktopHost().getResolvedWork?.(fingerprints)) ?? []
      } catch {
        nextNotice = nextNotice || '处理记录暂时无法读取，异常仍会保留。'
      }
      if (isCurrent()) {
        const hidden = new Set([...resolved, ...locallyResolved.current])
        const visibleAttention = nextDesk.attention.filter(
          (item) => !item.fingerprint || !hidden.has(item.fingerprint)
        )
        const visibleActive = nextDesk.active
        setDesk({
          attention: visibleAttention,
          active: visibleActive
        })
        const observed = snapshot.sessions.length + nextTasks.length
        setObservation({
          sourcePort: snapshot.runtime.port > 0 ? snapshot.runtime.port : null,
          sessions: snapshot.sessions.length,
          tasks: nextTasks.length,
          retired: Math.max(0, observed - visibleAttention.length - visibleActive.length)
        })
        setNotice(nextNotice)
        setDecisionNotice(
          decisionsResult.ok ? '' : '待确认事项暂时无法读取，其他工作事实仍可查看。'
        )
        setCollaborationSnapshot(snapshot)
        setTasks(nextTasks)
        setDecisions(nextDecisions)
      }
    } catch {
      if (!isCurrent()) return
      setNotice('')
      setError('工作摘要暂时无法读取，稍后将自动重试。')
    } finally {
      if (isCurrent()) setLoading(false)
    }
  }

  async function refreshIntervention(item: WorkItem): Promise<void> {
    const seq = ++interventionSeq.current
    const isCurrent = () => seq === interventionSeq.current
    setInterventionLoading(true)
    setInterventionStatus('')
    try {
      const profile = encodeURIComponent(item.profile)
      const [routingPayload, handoffPayload] = await Promise.all([
        api.request(`/origin/ea/routing-decisions?profile=${profile}&limit=20`),
        api.request<string>('/origin/ea/handoff.md')
      ])
      if (!isCurrent()) return
      setInterventionSummary(buildInterventionSummary(routingPayload))
      setHandoff(typeof handoffPayload === 'string' ? handoffPayload : '')
    } catch {
      if (!isCurrent()) return
      setInterventionStatus('干预建议暂时无法读取，请稍后重试。')
    } finally {
      if (isCurrent()) setInterventionLoading(false)
    }
  }

  async function refreshTaskboard(): Promise<void> {
    const seq = ++taskboardSeq.current
    const isCurrent = () => seq === taskboardSeq.current
    setTaskboardLoading(true)
    try {
      const snapshot = await desktopHost().getTaskboardSnapshot?.()
      if (isCurrent() && snapshot) setTaskboardSnapshot(snapshot)
    } catch {
      if (!isCurrent()) return
      setTaskboardSnapshot((current) => ({
        ...current,
        state: 'disconnected',
        writable: false,
        message: '本地 Taskboard 暂时不可用，实时工作不受影响。'
      }))
    } finally {
      if (isCurrent()) setTaskboardLoading(false)
    }
  }

  async function connectTaskboard(): Promise<void> {
    const seq = ++taskboardSeq.current
    const isCurrent = () => seq === taskboardSeq.current
    setTaskboardLoading(true)
    try {
      const snapshot = await desktopHost().connectTaskboard?.()
      if (isCurrent() && snapshot) setTaskboardSnapshot(snapshot)
    } catch {
      if (isCurrent()) setActionStatus('Taskboard 连接失败，请确认 launcher 文件后重试。')
    } finally {
      if (isCurrent()) setTaskboardLoading(false)
    }
  }

  async function acknowledge(item: WorkItem): Promise<void> {
    if (!item.fingerprint) return
    setActionLoading(true)
    setActionStatus('')
    try {
      const resolveWork = desktopHost().resolveWork
      if (!resolveWork) throw new Error('unavailable')
      await resolveWork(item.fingerprint, 'acknowledged')
      locallyResolved.current.add(item.fingerprint)
      setDesk((current) => ({
        ...current,
        attention: current.attention.filter(
          (candidate) => candidate.fingerprint !== item.fingerprint
        )
      }))
      setSelectedKey(null)
      setActionStatus('已从当前工作关闭；运行历史仍然保留。')
    } catch {
      setActionStatus('暂时无法记录处理结果，请稍后重试。')
    } finally {
      setActionLoading(false)
    }
  }

  function beginPromotion(item: WorkItem): void {
    if (!item.fingerprint || !item.attentionKind) return
    const acceptance: Record<NonNullable<WorkItem['attentionKind']>, string> = {
      failed: '修复后完成一次验证。',
      timed_out: '确认超时原因并完成一次验证。',
      detached: '确认连接恢复并完成一次验证。',
      transport_lost: '确认连接恢复并完成一次验证。',
      stale: '确认会话状态并决定继续或关闭。',
      blocked: '解除验证阻塞并记录验收结果。'
    }
    setPromoteStatus('')
    setPromoteDraft({
      fingerprint: item.fingerprint,
      title: item.title,
      sourceKind: item.kind,
      failureKind: item.attentionKind,
      acceptance: acceptance[item.attentionKind]
    })
  }

  async function confirmPromotion(): Promise<void> {
    if (!promoteDraft || !taskboardSnapshot.writable) return
    setPromoteLoading(true)
    setPromoteStatus('')
    try {
      const host = desktopHost()
      if (!host.createTaskboardWork) throw new Error('unavailable')
      const created = await host.createTaskboardWork(promoteDraft)
      locallyResolved.current.add(promoteDraft.fingerprint)
      setDesk((current) => ({
        ...current,
        attention: current.attention.filter((item) => item.fingerprint !== promoteDraft.fingerprint)
      }))
      setSelectedKey(null)
      try {
        if (!host.resolveWork) throw new Error('unavailable')
        await host.resolveWork(promoteDraft.fingerprint, 'promoted', created.identifier)
        setActionStatus(`已创建 ${created.identifier}；运行历史仍然保留。`)
      } catch {
        setActionStatus(`已创建 ${created.identifier}，但本地处理记录未写入，请勿重复创建。`)
      }
      setPromoteDraft(null)
      void refreshTaskboard()
    } catch {
      setPromoteStatus('创建失败，原异常仍保留；请检查 Taskboard 后重试。')
    } finally {
      setPromoteLoading(false)
    }
  }

  useEffect(() => {
    void refresh()
    const refreshTimer = window.setInterval(() => void refresh(), 3_000)
    void refreshTaskboard()
    const taskboardTimer = window.setInterval(() => void refreshTaskboard(), 15_000)
    const clockTimer = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => {
      window.clearInterval(refreshTimer)
      window.clearInterval(taskboardTimer)
      window.clearInterval(clockTimer)
      refreshSeq.current += 1
      taskboardSeq.current += 1
    }
  }, [])

  useEffect(() => {
    const liveDesk = buildWorkDesk(collaborationSnapshot, tasks, now)
    const liveByKey = new Map(
      [...liveDesk.attention, ...liveDesk.active].map((item) => [item.key, item])
    )
    setDesk((current) => {
      const retain = (items: WorkItem[], bucket: keyof WorkDesk) =>
        items.flatMap((item) => {
          const live = liveByKey.get(item.key)
          return live?.bucket === bucket ? [live] : []
        })
      const attention = retain(current.attention, 'attention')
      const active = retain(current.active, 'active')
      const unchanged =
        attention.length === current.attention.length &&
        active.length === current.active.length &&
        attention.every((item, index) => sameWorkItem(item, current.attention[index])) &&
        active.every((item, index) => sameWorkItem(item, current.active[index]))
      return unchanged ? current : { attention, active }
    })
  }, [collaborationSnapshot, now, tasks])

  useEffect(() => {
    setObservation((current) => {
      if (!current) return current
      const retired = Math.max(
        0,
        current.sessions + current.tasks - desk.attention.length - desk.active.length
      )
      return retired === current.retired ? current : { ...current, retired }
    })
  }, [desk.active.length, desk.attention.length])

  useEffect(() => {
    if (!selectedItem) return
    setInterventionSummary(null)
    setHandoff('')
    void refreshIntervention(selectedItem)
    return () => {
      interventionSeq.current += 1
    }
  }, [selectedItem?.key, selectedItem?.profile])

  useEffect(() => {
    if (selectedKey && !selectedItem) setSelectedKey(null)
  }, [selectedItem, selectedKey])

  if (loading && !error && Object.values(desk).every((items) => items.length === 0)) {
    return <LoadingState label="正在加载当前工作…" />
  }

  return (
    <ControlView
      eyebrow="DAO WORK DESK"
      title="当前工作"
      description="集中查看需要处理和正在运行的协作工作；已结束内容仍保留在历史中。"
      onRefresh={() => void refresh()}
      loading={loading}
    >
      <div className="work-desk-stack">
        {observation && (
          <div className="work-observation-strip" aria-label="当前工作观测状态">
            <strong>
              数据源 {observation.sourcePort ? `本机 :${observation.sourcePort}` : '本机运行时'}
            </strong>
            <span>观测到 {observation.sessions} 个会话</span>
            <span>{observation.tasks} 个长任务</span>
            <span>已退出实时桌 {observation.retired}</span>
          </div>
        )}
        <div className="work-desk-summary" aria-label="当前工作统计">
          <span>运行中 {desk.active.length}</span>
          <span>待处理 {desk.attention.length}</span>
          <span>计划事项 {taskboardSnapshot.items.length}</span>
        </div>
        <DeskActivityFeed
          events={deskEvents}
          now={now}
          healthy={!error}
          onOpenDecisions={onNavigate ? () => onNavigate('decisions') : undefined}
        />
        {decisionNotice && <ControlStatus message={decisionNotice} />}
        <WorkSection
          title="需要我处理"
          bucket="attention"
          items={desk.attention}
          now={now}
          onSelectItem={(item) => setSelectedKey(item.key)}
        />
        <TaskboardWorkPanel
          snapshot={taskboardSnapshot}
          loading={taskboardLoading}
          now={now}
          onRefresh={() => void refreshTaskboard()}
          onConnect={() => void connectTaskboard()}
        />
        <WorkSection
          title="正在进行"
          bucket="active"
          items={desk.active}
          now={now}
          onSelectItem={(item) => setSelectedKey(item.key)}
        />
        {Object.values(desk).every((items) => items.length === 0) && onNavigate && (
          <ControlPanel title="还没有可处理的工作" note="可以先看实时情况或接入渠道">
            {observation && (
              <p className="work-observation-empty-note">
                观测正常；当前没有 Agent 正在运行。已结束内容可在历史页查看。
              </p>
            )}
            <div className="work-desk-empty-actions">
              <ActionButton onClick={() => onNavigate('hud')}>查看实时情况</ActionButton>
              <ActionButton onClick={() => onNavigate('providers')}>查看接入渠道</ActionButton>
            </div>
          </ControlPanel>
        )}
        {selectedItem && selectedCapsule && (
          <WorkCapsulePanel
            capsule={selectedCapsule}
            now={now}
            actionLoading={actionLoading}
            onOpenItem={() => onOpenItem(selectedItem)}
            onAcknowledge={() => void acknowledge(selectedItem)}
            onPromote={() => beginPromotion(selectedItem)}
          >
            {selectedItem.kind === 'task' && selectedTask && (
              <WorkItemArtifactPanel task={selectedTask} />
            )}
            <WorkItemInterventionPanel
              title={selectedItem.title}
              summary={interventionSummary}
              handoff={handoff}
              loading={interventionLoading}
              status={interventionStatus}
              onRefresh={() => void refreshIntervention(selectedItem)}
            />
          </WorkCapsulePanel>
        )}
        {promoteDraft && (
          <PromoteWorkDialog
            open
            draft={promoteDraft}
            writable={taskboardSnapshot.writable}
            busy={promoteLoading}
            status={promoteStatus}
            onCancel={() => {
              setPromoteDraft(null)
              setPromoteStatus('')
            }}
            onConfirm={() => void confirmPromotion()}
          />
        )}
      </div>
      <ControlStatus message={error || notice || actionStatus} error={Boolean(error)} />
    </ControlView>
  )
}

function sameWorkItem(left: WorkItem, right: WorkItem | undefined): boolean {
  return Boolean(
    right &&
    left.key === right.key &&
    left.kind === right.kind &&
    left.bucket === right.bucket &&
    left.source === right.source &&
    left.title === right.title &&
    left.phase === right.phase &&
    left.route === right.route &&
    left.profile === right.profile &&
    left.updatedAt === right.updatedAt &&
    left.tone === right.tone &&
    left.suggestion === right.suggestion &&
    left.fingerprint === right.fingerprint &&
    left.attentionKind === right.attentionKind &&
    left.target.view === right.target.view &&
    left.target.id === right.target.id &&
    left.routeFacts.provider === right.routeFacts.provider &&
    left.routeFacts.upstreamModel === right.routeFacts.upstreamModel &&
    left.routeFacts.modelUid === right.routeFacts.modelUid &&
    left.routeFacts.provisional === right.routeFacts.provisional &&
    left.pulse?.current === right.pulse?.current &&
    left.pulse?.progress === right.pulse?.progress &&
    left.pulse?.outcome === right.pulse?.outcome
  )
}

function WorkSection({
  title,
  bucket,
  items,
  now,
  onSelectItem
}: {
  title: string
  bucket: keyof WorkDesk
  items: WorkItem[]
  now: number
  onSelectItem(item: WorkItem): void
}) {
  return (
    <ControlPanel title={title} className="work-desk-section" note={`${items.length} 条`}>
      {items.length === 0 ? (
        <ControlListEmpty label={EMPTY_LABELS[bucket]} />
      ) : (
        <div className="work-desk-list" role="list" aria-label={title}>
          {items.map((item) => (
            <WorkItemCard key={item.key} item={item} now={now} onSelectItem={onSelectItem} />
          ))}
        </div>
      )}
    </ControlPanel>
  )
}

function WorkItemCard({
  item,
  now,
  onSelectItem
}: {
  item: WorkItem
  now: number
  onSelectItem(item: WorkItem): void
}) {
  const pulseLabel = item.pulse ? ` · 现在在做 ${item.pulse.current}` : ''
  const label = `${item.title}${pulseLabel} · ${item.kind === 'session' ? '查看协作会话' : '查看任务详情'}`
  const currentModel =
    item.routeFacts.upstreamModel || item.routeFacts.modelUid || '尚未识别当前模型'
  const modelLabel = item.routeFacts.provisional ? '候选模型' : '正在使用的模型'
  const providerLabel = item.routeFacts.provisional
    ? '渠道选择中'
    : item.routeFacts.provider
      ? `渠道 ${item.routeFacts.provider}`
      : '渠道未上报'
  const routeLabel = item.routeFacts.modelUid
    ? `路由名 ${item.routeFacts.modelUid}`
    : '路由名未上报'
  return (
    <button
      type="button"
      className={`work-item-card tone-${item.tone}`}
      aria-label={label}
      onClick={() => onSelectItem(item)}
    >
      <span className="work-item-card-heading">
        <strong>{item.title}</strong>
        <span>{item.source}</span>
      </span>
      {item.pulse && (
        <>
          <span className="work-item-card-pulse">现在在做：{item.pulse.current}</span>
          <span className="work-item-card-pulse-meta">
            {item.pulse.progress} · {item.pulse.outcome}
          </span>
        </>
      )}
      <span className="work-item-card-model">
        {modelLabel}：{currentModel}
      </span>
      <span className="work-item-card-route">
        {providerLabel} · {routeLabel}
      </span>
      <span className="work-item-card-meta">{item.phase}</span>
      <span className="work-item-card-meta">
        {formatRelativeAge(now, item.updatedAt)} · {item.suggestion}
      </span>
    </button>
  )
}
