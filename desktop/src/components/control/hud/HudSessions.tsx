import {
  formatAge,
  formatCompact,
  formatInteger,
  formatLatency,
  formatPercent
} from './hudFormatters'
import { HudPanelHeading } from './HudPanelHeading'
import { hudToneForSession, type HudProvider, type HudSession, type HudTone } from './hudProjection'

export type HudSurfaceFilter = 'all' | 'devin' | 'codex'

export function HudSessions({
  sessions,
  providers,
  selectedSessionId,
  surfaceFilter,
  now,
  onSelectSession,
  onSelectSurface
}: {
  sessions: HudSession[]
  providers: HudProvider[]
  selectedSessionId: string
  surfaceFilter: HudSurfaceFilter
  now: number
  onSelectSession(id: string): void
  onSelectSurface(filter: HudSurfaceFilter): void
}) {
  const visibleSessions = sessions.filter(
    (session) => surfaceFilter === 'all' || session.surface === surfaceFilter
  )
  const selected =
    visibleSessions.find((session) => session.id === selectedSessionId) ??
    visibleSessions.find((session) => session.active) ??
    visibleSessions[0]

  return (
    <>
      <section className="hud-panel hud-sessions-panel" aria-label="会话状态">
        <HudPanelHeading
          eyebrow="SESSIONS"
          title="会话状态"
          aside={
            <>
              <div className="hud-segmented" aria-label="会话来源筛选">
                {(['all', 'devin', 'codex'] as const).map((filter) => (
                  <button
                    aria-pressed={surfaceFilter === filter}
                    key={filter}
                    onClick={() => onSelectSurface(filter)}
                    type="button"
                  >
                    {filter === 'all' ? '全部' : filter.toUpperCase()}
                  </button>
                ))}
              </div>
              <span className="hud-count-chip">{visibleSessions.length}</span>
            </>
          }
        />
        <p className="hud-panel-explainer">超过 5 分钟无活动即退出当前工作，历史不删除。</p>
        {visibleSessions.length === 0 ? (
          <p className="hud-empty">尚未捕获 Agent 会话</p>
        ) : (
          <div className="hud-session-list" role="list" aria-label="会话列表">
            {visibleSessions.map((session) => {
              const tone = hudToneForSession(session)
              const total = session.todo.total || 1
              const currentModel =
                session.route.upstreamModel !== '—'
                  ? session.route.upstreamModel
                  : session.route.modelUid
              const modelLabel = session.route.provisional ? '候选模型' : '正在使用的模型'
              const providerLabel = session.route.provisional
                ? '渠道选择中'
                : session.route.provider !== '—'
                  ? `渠道 ${session.route.provider}`
                  : '渠道未上报'
              const routeLabel =
                session.route.modelUid !== '—' ? `路由名 ${session.route.modelUid}` : '路由名未上报'
              return (
                <button
                  className={`hud-session-item ${selected?.id === session.id ? 'is-selected' : ''}`}
                  key={session.id}
                  onClick={() => onSelectSession(session.id)}
                  role="listitem"
                  type="button"
                >
                  <span className="hud-session-topline">
                    <b>{session.surface.toUpperCase()}</b>
                    <i
                      className={`hud-state-dot hud-tone-${tone}`}
                      aria-label={sessionStateLabel(session)}
                    />
                  </span>
                  <strong>{session.goal}</strong>
                  <span className="hud-session-model">
                    <b>{modelLabel}</b>
                    <strong>{currentModel || '尚未识别当前模型'}</strong>
                    <small>
                      {providerLabel} · {routeLabel}
                    </small>
                  </span>
                  <span className="hud-session-meta">
                    <span>{session.phase}</span>
                    <span>{session.workspace}</span>
                    <span>{formatAge(Math.max(0, now - session.latestActivityAt))}</span>
                  </span>
                  <span className="hud-session-progress">
                    <progress max={total} value={Math.min(session.todo.completed, total)} />
                    <b>
                      {session.todo.total ? `${session.todo.completed}/${session.todo.total}` : '—'}
                    </b>
                  </span>
                </button>
              )
            })}
          </div>
        )}
      </section>
      <HudSelectedSession session={selected} providers={providers} now={now} />
    </>
  )
}

function sessionStateLabel(session: HudSession): string {
  if (session.warning) return '告警'
  if (session.active) return '活跃'
  if (session.lifecycle === 'recently-ended') return '最近结束'
  if (session.stale) return '过期'
  return '非活跃'
}

function TonePill({ tone, children }: { tone: HudTone; children: string }) {
  return <span className={`hud-state-pill hud-tone-${tone}`}>{children}</span>
}

function HudSelectedSession({
  session,
  providers,
  now
}: {
  session: HudSession | undefined
  providers: HudProvider[]
  now: number
}) {
  if (!session) {
    return (
      <section className="hud-panel hud-session-detail" aria-label="当前任务">
        <HudPanelHeading eyebrow="SELECTED TASK" title="当前任务" />
        <div className="hud-session-empty">
          <span>NO ACTIVE SESSION</span>
          <h4>等待 Dao 捕获会话</h4>
          <p>发起一轮经由 Dao 的对话后，这里会显示任务、路线、验证与缓存状态。</p>
        </div>
      </section>
    )
  }

  const tone = hudToneForSession(session)
  const provider = providers.find((item) => item.id === session.route.provider)
  const total = session.todo.total || 1
  const cache = session.cache
  const facts = [
    {
      label: '验证',
      value: session.verification.status.toUpperCase(),
      note: session.verification.blocking ? '存在完成阻塞' : '无完成阻塞'
    },
    {
      label: '失败信号',
      value: `${formatInteger(session.failures.maxConsecutive)} MAX · ${formatInteger(session.failures.sameCallStreak)} REPEAT`,
      note:
        session.failures.lastToolOk === true
          ? '最近工具成功'
          : session.failures.lastToolOk === false
            ? '最近工具失败'
            : '工具状态未知'
    },
    {
      label: '会话缓存',
      value: cache.observed ? formatPercent(cache.hitRate) : '—',
      note: cache.observed
        ? `${formatInteger(cache.calls)} 次 · 读 ${formatCompact(cache.cached)} · 写 ${formatCompact(cache.cacheWrite)}`
        : '暂无会话缓存样本'
    },
    {
      label: '新鲜度',
      value: formatAge(Math.max(0, now - session.latestActivityAt)),
      note: `${session.mode.toUpperCase()} · ${session.identityKind}`
    },
    {
      label: '推理 Token',
      value: formatCompact(session.telemetry.reasoningTokens),
      note: '当前任务最近一轮'
    },
    { label: '首字延迟', value: formatLatency(session.telemetry.ttftMs), note: 'TTFT' },
    { label: '轮次耗时', value: formatLatency(session.telemetry.durationMs), note: 'DURATION' },
    {
      label: '渠道 TTFT P50',
      value: formatLatency(provider?.latency.overall.p50TtftMs ?? null),
      note: 'PROVIDER MEDIAN'
    },
    {
      label: '渠道 TTFT P95',
      value: formatLatency(provider?.latency.overall.p95TtftMs ?? null),
      note: 'PROVIDER TAIL'
    },
    {
      label: '缓存命中 P95',
      value: formatLatency(provider?.latency.cache.hit.p95TtftMs ?? null),
      note: 'CACHE HIT'
    },
    {
      label: '缓存未命中 P95',
      value: formatLatency(provider?.latency.cache.miss.p95TtftMs ?? null),
      note: 'CACHE MISS'
    },
    {
      label: '上下文压缩',
      value: formatInteger(session.telemetry.compactions),
      note: 'COMPACTIONS'
    },
    { label: '模型路径', value: session.telemetry.modelPath.toUpperCase(), note: 'CONTROL PLANE' },
    { label: '状态来源', value: session.telemetry.loopSource.toUpperCase(), note: 'LOOP SOURCE' }
  ]

  return (
    <section className="hud-panel hud-session-detail" aria-label="当前任务">
      <HudPanelHeading
        eyebrow="SELECTED TASK"
        title="当前任务"
        aside={
          <div className="hud-badge-row">
            {session.active && <TonePill tone="live">LIVE</TonePill>}
            {!session.active && session.lifecycle === 'recently-ended' && (
              <TonePill tone="warning">RECENT</TonePill>
            )}
            {session.warning && <TonePill tone="danger">WARNING</TonePill>}
            {!session.warning && session.stale && <TonePill tone="warning">STALE</TonePill>}
            <TonePill tone={tone}>{session.mode}</TonePill>
          </div>
        }
      />
      <div className="hud-session-detail-content">
        <div className="hud-goal-block">
          <span>GOAL</span>
          <h4>{session.goal}</h4>
          <div>
            <b>{session.surface.toUpperCase()}</b>
            <b>{session.workspace}</b>
            <b>#{session.id}</b>
          </div>
        </div>
        <div className="hud-progress-block">
          <span>
            <b>{session.phase.toUpperCase()}</b>
            <strong>
              {session.todo.total
                ? `${session.todo.completed} / ${session.todo.total}`
                : '未提供计划'}
            </strong>
          </span>
          <progress max={total} value={Math.min(session.todo.completed, total)} />
          <p>{session.todo.current}</p>
        </div>
        <div className="hud-route-block" aria-label="当前路由">
          <HudRouteNode label="路由名" value={session.route.modelUid} />
          <span aria-hidden="true">→</span>
          <HudRouteNode
            label="渠道"
            value={session.route.provisional ? '选择中' : session.route.provider}
            emphasized
          />
          <span aria-hidden="true">→</span>
          <HudRouteNode label="正在使用的模型" value={session.route.upstreamModel} />
        </div>
        <div className="hud-session-facts">
          {facts.map((fact) => (
            <article key={fact.label}>
              <span>{fact.label}</span>
              <strong title={fact.value}>{fact.value}</strong>
              <small title={fact.note}>{fact.note}</small>
            </article>
          ))}
        </div>
      </div>
    </section>
  )
}

function HudRouteNode({
  label,
  value,
  emphasized = false
}: {
  label: string
  value: string
  emphasized?: boolean
}) {
  return (
    <div className={`hud-route-node ${emphasized ? 'is-emphasized' : ''}`}>
      <span>{label}</span>
      <strong title={value}>{value}</strong>
    </div>
  )
}
