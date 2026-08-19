import { Activity, Layers3, Radio, Route, ShieldAlert, TimerReset } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'

import {
  ControlBadge,
  ControlReadout,
  ControlReadoutGrid
} from '@/components/control/ControlReadout'
import { formatPercent } from '@/components/control/hud/hudFormatters'
import { CollaborationAttentionQueue } from '@/components/collaboration/CollaborationAttentionQueue'
import { CollaborationChannelHealthView } from '@/components/collaboration/CollaborationChannelHealthView'
import { AcpSessionDiagnosticsView } from '@/components/collaboration/AcpSessionDiagnosticsView'
import { CollaborationHandoffActions } from '@/components/collaboration/CollaborationHandoffActions'
import { buildSessionHandoff } from '@/components/collaboration/collaborationHandoff'
import {
  ControlPanel,
  ControlStatus,
  ControlView,
  LoadingState,
  useDaoApi
} from '@/components/control/ControlPrimitives'
import { CollaborationActivityFeed } from '@/components/collaboration/CollaborationActivityFeed'
import { ChannelCapabilityPanel } from '@/components/collaboration/ChannelCapabilityPanel'
import { projectChannelCapabilities } from '@/components/collaboration/channelCapabilityModel'
import {
  formatRelativeAge,
  normalizeCollaborationSnapshot,
  normalizeTasks,
  sessionTone,
  surfaceLabel,
  type CollaborationProvider,
  type CollaborationSession,
  type CollaborationSnapshot,
  type CollaborationTask,
  type CollaborationTone
} from '@/components/collaboration/collaborationModel'
import { buildCollaborationDesk } from '@/components/collaboration/collaborationDeskModel'
import type { DaoViewId } from '@/lib/views'

type SurfaceFilter = 'all' | 'acp' | 'codex' | 'devin'

const SURFACE_FILTERS: Array<{ id: SurfaceFilter; label: string }> = [
  { id: 'all', label: '全部' },
  { id: 'acp', label: 'ACP' },
  { id: 'codex', label: 'CODEX' },
  { id: 'devin', label: 'DEVIN' }
]

function toneLabel(tone: CollaborationTone): string {
  return { good: '正常', warn: '注意', bad: '告警', muted: '未知', brand: '受控' }[tone]
}

function visibleSessions(
  sessions: CollaborationSession[],
  filter: SurfaceFilter
): CollaborationSession[] {
  return filter === 'all' ? sessions : sessions.filter((session) => session.surface === filter)
}

export function AcpWorkbenchControlView({
  selectedSessionId,
  onNavigate
}: { selectedSessionId?: string; onNavigate?: (view: DaoViewId) => void } = {}) {
  const api = useDaoApi()
  const [snapshot, setSnapshot] = useState<CollaborationSnapshot>({
    generatedAt: 0,
    sessions: [],
    providers: [],
    recentRequests: [],
    runtime: { healthy: false, mode: 'unknown', port: 0, connection: 'offline' }
  })
  const [surfaceFilter, setSurfaceFilter] = useState<SurfaceFilter>('all')
  const [tasks, setTasks] = useState<CollaborationTask[]>([])
  const [selectedId, setSelectedId] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [taskNotice, setTaskNotice] = useState('')
  const [now, setNow] = useState(() => Date.now())
  const refreshSeq = useRef(0)

  async function refresh(): Promise<void> {
    const seq = ++refreshSeq.current
    const isCurrent = () => refreshSeq.current === seq
    setLoading(true)
    setError('')
    setTaskNotice('')
    try {
      const [hudResult, taskResult] = await Promise.allSettled([
        api.request('/origin/hud/snapshot'),
        api.request('/origin/tasks')
      ])
      if (!isCurrent()) return
      if (hudResult.status === 'rejected') throw hudResult.reason
      const next = normalizeCollaborationSnapshot(hudResult.value)
      setSnapshot(next)
      if (taskResult.status === 'fulfilled') {
        setTasks(normalizeTasks(taskResult.value).tasks)
      } else {
        setTaskNotice('任务详情暂不可用，会话观测仍正常。')
      }
      setSelectedId((current) =>
        selectedSessionId && next.sessions.some((session) => session.id === selectedSessionId)
          ? selectedSessionId
          : next.sessions.some((session) => session.id === current)
            ? current
            : next.sessions.find((session) => session.active)?.id || next.sessions[0]?.id || ''
      )
    } catch (cause) {
      if (!isCurrent()) return
      setError(cause instanceof Error ? cause.message : 'ACP 会话数据读取失败')
    } finally {
      if (isCurrent()) setLoading(false)
    }
  }

  useEffect(() => {
    void refresh()
    const refreshTimer = window.setInterval(() => void refresh(), 3_000)
    const clockTimer = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => {
      refreshSeq.current += 1
      window.clearInterval(refreshTimer)
      window.clearInterval(clockTimer)
    }
  }, [])

  const sessions = useMemo(
    () => visibleSessions(snapshot.sessions, surfaceFilter),
    [snapshot.sessions, surfaceFilter]
  )
  const selected =
    sessions.find((session) => session.id === selectedId) ??
    sessions.find((session) => session.active) ??
    sessions[0]
  const desk = useMemo(() => buildCollaborationDesk(snapshot, tasks, now), [snapshot, tasks, now])
  const channelCapabilities = useMemo(
    () => projectChannelCapabilities(snapshot, tasks),
    [snapshot, tasks]
  )

  const cacheSummary = useMemo(() => {
    const observed = snapshot.sessions.find((session) => session.cache.observed)
    const hitRequests = snapshot.recentRequests.filter((request) => request.cacheStatus === 'hit').length
    const measuredRequests = snapshot.recentRequests.filter(
      (request) => request.cacheStatus === 'hit' || request.cacheStatus === 'miss'
    ).length
    if (measuredRequests > 0) {
      return {
        hitRate: (hitRequests / measuredRequests) * 100,
        detail: `${hitRequests}/${measuredRequests} 次请求命中`
      }
    }
    if (observed) {
      return {
        hitRate: observed.cache.hitRate,
        detail: `${observed.cache.calls} 次会话缓存`
      }
    }
    return null
  }, [snapshot.sessions, snapshot.recentRequests])

  if (loading && !snapshot.generatedAt && !error)
    return <LoadingState label="正在加载 ACP 协作工作台…" />

  return (
    <ControlView
      eyebrow="ACP COLLABORATION / SESSION WORKBENCH"
      title="ACP 协作"
      description="一张桌查看 Agent、会话、任务、路由证据、产物与人工交接。没有可靠关系的数据会分开显示。"
      onRefresh={() => void refresh()}
      loading={loading}
    >
      <ControlReadoutGrid>
        <ControlReadout
          label="活跃会话"
          value={snapshot.sessions.filter((session) => session.active).length}
          detail={`${snapshot.sessions.length} 条最近会话`}
          tone="good"
        />
        <ControlReadout
          label="需要关注"
          value={snapshot.sessions.filter((session) => session.warning).length}
          detail="失败 / 验证阻塞"
          tone={snapshot.sessions.some((session) => session.warning) ? 'bad' : 'muted'}
        />
        <ControlReadout
          label="缓存命中"
          value={cacheSummary ? formatPercent(cacheSummary.hitRate) : '—'}
          detail={cacheSummary?.detail ?? '等待缓存观测样本'}
          tone={cacheSummary ? 'brand' : 'muted'}
        />
        <ControlReadout
          label="观测请求"
          value={snapshot.recentRequests.length}
          detail="最近安全样本"
          tone="brand"
        />
        <ControlReadout
          label="运行时"
          value={snapshot.runtime.healthy ? 'LIVE' : 'OFFLINE'}
          detail={snapshot.runtime.mode}
          tone={snapshot.runtime.healthy ? 'good' : 'warn'}
        />
      </ControlReadoutGrid>

      <ControlPanel title="Agent 名册" note={`${desk.agents.length} 个安全身份 · 来源入口`}>
        {desk.agents.length === 0 ? (
          <p className="empty-note">等待 Agent 会话进入本地观测源</p>
        ) : (
          <div className="collaboration-agent-roster" role="list" aria-label="Agent 名册">
            {desk.agents.map((agent) => (
              <article key={agent.key} role="listitem">
                <strong>{agent.label}</strong>
                <span>{agent.active ? '正在工作' : '最近出现'}</span>
                <small>
                  上游模型 {agent.model} · 上游渠道 {agent.provider}
                </small>
              </article>
            ))}
          </div>
        )}
      </ControlPanel>

      <ChannelCapabilityPanel capabilities={channelCapabilities} />

      <ControlPanel title="协作链" note="只展示可信关系 · 5 分钟实时窗口">
        <div className="collaboration-desk-lanes">
          {desk.sessionLanes.map((lane) => (
            <article key={lane.key} className="collaboration-desk-lane">
              <strong>{lane.goal}</strong>
              <small>{lane.current}</small>
            </article>
          ))}
          <section className="collaboration-unlinked-lane" aria-label="尚未关联到会话的任务">
            <div className="collaboration-lane-heading">
              <strong>尚未关联到会话的任务</strong>
              <span>任务源没有提供可信会话引用，因此不会猜测连线。</span>
            </div>
            {desk.unlinkedTasks.length === 0 ? (
              <p className="empty-note">最近 5 分钟没有可连线任务，历史请打开任务与产物。</p>
            ) : (
              desk.unlinkedTasks.map((task) => (
                <article key={task.key} className="collaboration-task-summary">
                  <span>
                    <strong>{task.title}</strong>
                    <small>
                      {task.phase} · {task.status}
                    </small>
                  </span>
                  <span>
                    尝试 {task.attemptCount} 次 · 产物 {task.artifactCount} 项
                  </span>
                </article>
              ))
            )}
            {desk.unlinkedTasks.length > 0 && onNavigate && (
              <button
                className="secondary-action"
                type="button"
                onClick={() => onNavigate('tasks')}
              >
                打开任务与产物
              </button>
            )}
          </section>
        </div>
      </ControlPanel>

      <div className="collaboration-filter-bar" role="toolbar" aria-label="会话来源筛选">
        <Radio size={15} aria-hidden="true" />
        {SURFACE_FILTERS.map((item) => (
          <button
            className="collaboration-filter"
            key={item.id}
            type="button"
            aria-pressed={surfaceFilter === item.id}
            onClick={() => {
              setSurfaceFilter(item.id)
              const next = visibleSessions(snapshot.sessions, item.id)
              setSelectedId(next.find((session) => session.active)?.id || next[0]?.id || '')
            }}
          >
            {item.label}
          </button>
        ))}
        <span className="collaboration-filter-count">{sessions.length} 个会话</span>
      </div>

      <CollaborationChannelHealthView
        providers={snapshot.providers}
        recentRequests={snapshot.recentRequests}
        sessions={snapshot.sessions}
      />

      <CollaborationAttentionQueue
        now={now}
        onSelectSession={(sessionId) => {
          setSurfaceFilter('all')
          setSelectedId(sessionId)
        }}
        selectedSessionId={selected?.id ?? ''}
        sessions={snapshot.sessions}
      />

      <div className="collaboration-split-grid acp-workbench-grid">
        <ControlPanel title="会话目录" note="SESSION REGISTRY" className="collaboration-list-panel">
          {sessions.length === 0 ? (
            <div className="collaboration-empty-detail">
              <Layers3 size={24} aria-hidden="true" />
              <strong>尚未捕获 ACP 会话</strong>
              <span>从 Codex、Devin 或兼容 ACP 的客户端发起一轮任务后，这里会出现协作谱系。</span>
            </div>
          ) : (
            <div className="collaboration-session-list" role="list" aria-label="ACP 会话列表">
              {sessions.map((session) => (
                <SessionRow
                  key={session.id}
                  now={now}
                  selected={session.id === selected?.id}
                  session={session}
                  onSelect={() => setSelectedId(session.id)}
                />
              ))}
            </div>
          )}
        </ControlPanel>
        <SessionDetail
          providers={snapshot.providers}
          session={selected}
          requests={snapshot.recentRequests}
          now={now}
        />
      </div>

      <ControlStatus message={error || taskNotice} error={Boolean(error)} />
    </ControlView>
  )
}

function SessionRow({
  session,
  selected,
  now,
  onSelect
}: {
  session: CollaborationSession
  selected: boolean
  now: number
  onSelect(): void
}) {
  const tone = sessionTone(session)
  return (
    <button
      className={`collaboration-session-row ${selected ? 'is-selected' : ''}`}
      type="button"
      aria-current={selected ? 'true' : undefined}
      onClick={onSelect}
    >
      <span className={`collaboration-session-dot tone-${tone}`} aria-hidden="true" />
      <span className="collaboration-session-main">
        <strong>{session.goal}</strong>
        <small>
          {surfaceLabel(session.surface)} · {session.workspace}
        </small>
        <span>
          {session.phase} · {formatRelativeAge(now, session.latestActivityAt)}
        </span>
      </span>
      <ControlBadge tone={tone}>{toneLabel(tone)}</ControlBadge>
    </button>
  )
}

function SessionDetail({
  session,
  providers,
  requests,
  now
}: {
  session: CollaborationSession | undefined
  providers: CollaborationProvider[]
  requests: CollaborationSnapshot['recentRequests']
  now: number
}) {
  if (!session) {
    return (
      <ControlPanel title="会话详情" note="NO SESSION">
        <div className="collaboration-empty-detail">
          <Activity size={24} aria-hidden="true" />
          <strong>等待第一个会话事件</strong>
          <span>Dao 会在会话创建、路由选择、回退和完成时更新这里。</span>
        </div>
      </ControlPanel>
    )
  }

  const relatedRequests = requests
    .filter((request) => request.source.toLocaleLowerCase() === session.surface)
    .slice(0, 8)
  const totalTodo = session.todo.total || 1
  const selectedProvider = providers.find((provider) => provider.id === session.route.provider)

  return (
    <ControlPanel
      title="当前会话"
      note={`${surfaceLabel(session.surface)} / ${session.lifecycle}`}
      className="collaboration-detail-panel"
    >
      <div className="collaboration-detail-heading">
        <div>
          <p className="workspace-kicker">
            {surfaceLabel(session.surface)} / {session.workspace}
          </p>
          <h3>{session.goal}</h3>
        </div>
        <div className="control-badge-row">
          {session.active && <ControlBadge tone="good">LIVE</ControlBadge>}
          {session.warning && <ControlBadge tone="bad">WARNING</ControlBadge>}
          {!session.warning && session.stale && <ControlBadge tone="warn">STALE</ControlBadge>}
        </div>
      </div>

      <div className="acp-route-chain" aria-label="会话路由">
        <Route size={15} aria-hidden="true" />
        <span>
          <small>MODEL UID</small>
          <strong>{session.route.modelUid}</strong>
        </span>
        <b aria-hidden="true">→</b>
        <span className="is-emphasized">
          <small>PROVIDER</small>
          <strong>{session.route.provider}</strong>
        </span>
        <b aria-hidden="true">→</b>
        <span>
          <small>UPSTREAM</small>
          <strong>{session.route.upstreamModel}</strong>
        </span>
      </div>

      <AcpSessionDiagnosticsView now={now} provider={selectedProvider} session={session} />

      <div className="acp-progress-line">
        <div>
          <span>当前待办</span>
          <strong>{session.todo.current}</strong>
        </div>
        <progress max={totalTodo} value={Math.min(session.todo.completed, totalTodo)} />
      </div>

      <CollaborationHandoffActions
        content={buildSessionHandoff(session, relatedRequests, now)}
        filename="dao-acp-session-handoff.md"
      />

      <CollaborationActivityFeed session={session} requests={relatedRequests} now={now} />

      <div className="acp-safety-note">
        <ShieldAlert size={14} aria-hidden="true" />
        <span>仅显示安全投影：无 prompt、密钥、完整路径与工具参数。</span>
        <TimerReset size={14} aria-hidden="true" />
        <span>每 3 秒刷新</span>
      </div>
    </ControlPanel>
  )
}
