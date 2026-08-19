import { useEffect, useMemo, useRef, useState } from 'react'

import { asArray, asRecord } from '@/lib/daoControlApi'
import { desktopHost } from '@/lib/desktopHost'
import type { DaoViewId } from '@/lib/views'
import { summarizeObservability, type ObservabilitySummaryCard } from '@/lib/observabilitySummary'
import {
  ROUTING_PROFILES,
  parseRoutingDecisions,
  topRoutingFactors,
  type RoutingDecision,
  type RoutingProfileId
} from '@/lib/routingDecision'

import {
  ActionButton,
  ControlListEmpty,
  ControlPanel,
  ControlStatus,
  ControlView,
  LoadingState,
  useDaoApi
} from './ControlPrimitives'
import { ControlBadge } from './ControlReadout'
import { formatDate } from './controlDisplay'

type ObservabilityState = {
  usage: Record<string, unknown>
  alerts: unknown[]
  failures: Record<string, unknown>
  traces: unknown[]
  audit: unknown[]
  backups: unknown[]
  routingDecisions: RoutingDecision[]
}

const initialState: ObservabilityState = {
  usage: {},
  alerts: [],
  failures: {},
  traces: [],
  audit: [],
  backups: [],
  routingDecisions: []
}

function listData(value: unknown, key: string): unknown[] {
  return asArray(asRecord(value)[key])
}

export function ObservabilityControlView({
  onNavigate
}: {
  onNavigate?: (view: DaoViewId) => void
}) {
  const api = useDaoApi()
  const [state, setState] = useState(initialState)
  const [routingProfile, setRoutingProfile] = useState<RoutingProfileId>('balanced')
  const [selectedBackup, setSelectedBackup] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')
  const [technicalOpen, setTechnicalOpen] = useState(false)
  const routingProfileMounted = useRef(false)

  async function refreshRouting(): Promise<void> {
    try {
      const routingRaw = await api.request(
        `/origin/ea/routing-decisions?profile=${routingProfile}&limit=20`
      )
      setState((current) => ({ ...current, routingDecisions: parseRoutingDecisions(routingRaw) }))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '路由建议读取失败')
    }
  }

  async function refresh(): Promise<void> {
    setLoading(true)
    setError('')
    try {
      const [usage, alerts, failures, traces, audit, backups, routingRaw] = await Promise.all([
        api.request('/origin/ea/usage'),
        api.request('/origin/ea/alerts?limit=50'),
        api.request('/origin/ea/failure-stats'),
        api.request('/origin/ea/traces?limit=50'),
        api.request('/origin/ea/audit?limit=50'),
        api.request('/origin/ea/config-backups'),
        api.request(`/origin/ea/routing-decisions?profile=${routingProfile}&limit=20`)
      ])
      setState({
        usage: asRecord(usage),
        alerts: listData(alerts, 'alerts'),
        failures: asRecord(failures),
        traces: listData(traces, 'traces'),
        audit: listData(audit, 'audit'),
        backups: listData(backups, 'backups'),
        routingDecisions: parseRoutingDecisions(routingRaw)
      })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '观测数据读取失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (!routingProfileMounted.current) {
      routingProfileMounted.current = true
      void refresh()
      return
    }
    void refreshRouting()
  }, [routingProfile])

  const totals = asRecord(state.usage.totals)
  const failureStats = asRecord(state.failures.stats)
  const failureRows = Object.entries(failureStats)
  const backupOptions = state.backups
    .map((item) => {
      const row = asRecord(item)
      return {
        value: String(row.path || row.file || row.name || ''),
        label: String(row.name || row.file || row.path || '备份')
      }
    })
    .filter((item) => item.value)
  const latestTrace = useMemo(() => state.traces.slice(0, 8), [state.traces])
  const routingProfileLabel =
    ROUTING_PROFILES.find((profile) => profile.id === routingProfile)?.label || '均衡'
  const latestRoutingDecision = state.routingDecisions[0]
  const routingSuggestionCount = latestRoutingDecision
    ? latestRoutingDecision.candidates.filter(
        (candidate) =>
          candidate.actualPriority != null &&
          candidate.advisoryRank != null &&
          candidate.actualPriority !== candidate.advisoryRank
      ).length
    : 0
  const summary = useMemo(
    () =>
      summarizeObservability({
        usage: state.usage,
        alerts: state.alerts,
        failures: state.failures,
        traces: state.traces,
        routingDecisions: state.routingDecisions
      }),
    [state]
  )

  function levelTone(value: unknown): 'good' | 'warn' | 'bad' | 'muted' {
    const level = String(value || '').toLocaleLowerCase()
    if (level === 'error' || level === 'failed') return 'bad'
    if (level === 'warn' || level === 'warning' || level === 'pending') return 'warn'
    if (level === 'ok' || level === 'info' || level === 'success') return 'good'
    return 'muted'
  }

  function budgetText(decision: RoutingDecision): string {
    if (decision.budget.status === 'not_requested') return '本次请求没有单独预算'
    if (decision.budget.status === 'strict_rejected') return '预算太低，已拒绝发送'
    if (decision.budget.status === 'cheapest_override') return '预算临时改走更便宜的渠道'
    if (decision.budget.capUsd != null) return `本次上限 $${decision.budget.capUsd}`
    return decision.budget.status ? `预算状态：${decision.budget.status}` : '预算状态未知'
  }

  function strategyText(strategy: string): string {
    if (strategy === 'priority') return '按你设置的顺序'
    if (strategy === 'random') return '随机尝试'
    return `当前选路方式：${strategy || '默认'}`
  }

  function outcomeText(value: string): string {
    if (value === 'selected') return '请求成功'
    if (value === 'budget_rejected') return '预算太低'
    if (value === 'exhausted') return '所有渠道都失败'
    if (value === 'failed') return '请求失败'
    if (value === 'pending') return '还在处理中'
    return value || '状态未知'
  }

  function alertLevelText(value: string): string {
    const level = value.toLocaleLowerCase()
    if (level === 'error' || level === 'failed') return '需要处理'
    if (level === 'warn' || level === 'warning' || level === 'pending') return '需要注意'
    if (level === 'ok' || level === 'success') return '已恢复'
    return '信息'
  }

  function runSummaryAction(card: ObservabilitySummaryCard): void {
    if (card.action?.view === 'observability') {
      setTechnicalOpen(true)
      return
    }
    if (card.action) onNavigate?.(card.action.view)
  }

  function outcomeTone(value: unknown): 'good' | 'warn' | 'bad' | 'muted' {
    const status = String(value || '').toLocaleLowerCase()
    if (status === 'selected') return 'good'
    if (status === 'budget_rejected' || status === 'exhausted' || status === 'failed') return 'bad'
    if (status === 'pending') return 'warn'
    return 'muted'
  }

  async function rollback(): Promise<void> {
    if (!selectedBackup) {
      setError('先选择一个配置备份')
      return
    }
    setBusy(true)
    setError('')
    try {
      await api.request('/origin/ea/config-rollback', 'POST', { backup: selectedBackup })
      setStatus(`已回滚到 ${selectedBackup}`)
      await refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '配置回滚失败')
    } finally {
      setBusy(false)
    }
  }

  async function exportPack(): Promise<void> {
    setBusy(true)
    setError('')
    try {
      const pack = await api.request('/origin/ea/config-pack')
      const result = await desktopHost().saveHandoff(
        JSON.stringify(pack, null, 2),
        'dao-flow-config-pack.json'
      )
      setStatus(result.ok ? '配置包已保存' : '已取消保存配置包')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '配置包导出失败')
    } finally {
      setBusy(false)
    }
  }

  async function importPack(file: File | undefined): Promise<void> {
    if (!file) return
    setBusy(true)
    setError('')
    try {
      if (file.size > 8 * 1024 * 1024) throw new Error('配置包超过 8 MiB 限制')
      const parsed: unknown = JSON.parse(await file.text())
      const record = asRecord(parsed)
      await api.request('/origin/ea/config-pack', 'POST', { pack: record.pack || record })
      setStatus('配置包已导入并热重载')
      await refresh()
    } catch (cause) {
      setError(cause instanceof Error ? `配置包导入失败：${cause.message}` : '配置包导入失败')
    } finally {
      setBusy(false)
    }
  }

  if (loading && state.traces.length === 0 && state.alerts.length === 0)
    return <LoadingState label="正在加载运行情况和问题…" />

  return (
    <ControlView
      eyebrow="运行中 / 问题与数据"
      title="问题与数据"
      description="先看结论：现在是否正常、刚刚发生了什么、要不要处理；需要排查时再展开技术细节。"
      onRefresh={() => void refresh()}
      loading={loading || busy}
    >
      <section className="observability-summary-grid" aria-label="运行结论">
        {summary.cards.map((card) => (
          <article className={`observability-summary-card tone-${card.tone}`} key={card.id}>
            <h3>{card.question}</h3>
            <strong className="observability-summary-headline">{card.headline}</strong>
            <p>{card.detail}</p>
            {card.action && (
              <button
                className="summary-card-action"
                type="button"
                onClick={() => runSummaryAction(card)}
              >
                {card.action.label}
              </button>
            )}
          </article>
        ))}
      </section>
      <div className="metric-row">
        <article className="metric-card">
          <span>请求次数</span>
          <strong>{String(totals.calls || 0)}</strong>
          <small>最近捕获的请求总数</small>
        </article>
        <article className="metric-card">
          <span>处理量</span>
          <strong>{String(totals.total || 0)}</strong>
          <small>
            输入量 {String(totals.input || 0)} · 输出量 {String(totals.output || 0)}
          </small>
        </article>
        <article className="metric-card">
          <span>失败渠道</span>
          <strong>{failureRows.length}</strong>
          <small>
            {state.alerts.length} 条提醒 · {state.traces.length} 次请求记录
          </small>
        </article>
        <article className="metric-card">
          <span>路由建议</span>
          <strong>{state.routingDecisions.length}</strong>
          <small>
            {routingProfileLabel} · {routingSuggestionCount} 个顺序不同
          </small>
        </article>
      </div>
      <ControlPanel title="模型怎么走的建议" note={`${routingProfileLabel} · 只用于对比`}>
        <div className="control-actions-row control-actions-row-tight">
          <select
            aria-label="路由建议 profile"
            value={routingProfile}
            onChange={(event) => setRoutingProfile(event.target.value as RoutingProfileId)}
          >
            {ROUTING_PROFILES.map((profile) => (
              <option key={profile.id} value={profile.id}>
                {profile.label}
              </option>
            ))}
          </select>
        </div>
        <p className="empty-note">
          这里的建议只用于看一眼“如果更看重速度/成本，顺序会不会不同”，不会改变真实流量；实际顺序仍以配置和人工保存为准。
        </p>
        {state.routingDecisions.length === 0 ? (
          <ControlListEmpty label="尚未捕获路由建议快照。" />
        ) : (
          <div className="control-event-list routing-decision-list">
            {state.routingDecisions.slice(0, 8).map((decision) => {
              const selected =
                decision.outcome.provider || decision.outcome.model
                  ? `${decision.outcome.provider || '—'} / ${decision.outcome.model || '—'}`
                  : '尚未选中'
              return (
                <details key={decision.id}>
                  <summary>
                    <strong>
                      <ControlBadge tone={outcomeTone(decision.outcome.status)}>
                        {outcomeText(decision.outcome.status)}
                      </ControlBadge>{' '}
                      {decision.model || decision.id}
                    </strong>{' '}
                    <span>
                      {strategyText(decision.channelStrategy)} · {selected} · {budgetText(decision)}{' '}
                      · {formatDate(decision.at)}
                    </span>
                  </summary>
                  <div className="routing-candidate-list">
                    {decision.candidates.slice(0, 8).map((candidate) => {
                      const drift =
                        candidate.actualPriority != null &&
                        candidate.advisoryRank != null &&
                        candidate.actualPriority !== candidate.advisoryRank
                      return (
                        <div
                          className={`routing-candidate-row ${drift ? 'has-routing-drift' : ''}`}
                          key={`${decision.id}-${candidate.provider}-${candidate.model}`}
                        >
                          <div>
                            <strong>
                              实际优先级 #{candidate.actualPriority ?? '—'}{' '}
                              {candidate.provider || '—'}
                            </strong>
                            <span>{candidate.model || '—'}</span>
                          </div>
                          <div>
                            <ControlBadge tone={drift ? 'warn' : 'good'}>
                              建议 #{candidate.advisoryRank ?? '—'}
                            </ControlBadge>
                            <small>
                              参考分{' '}
                              {candidate.advisoryScore == null
                                ? '—'
                                : candidate.advisoryScore.toFixed(3)}
                            </small>
                          </div>
                          <small>
                            {topRoutingFactors(candidate)
                              .map((factor) => `${factor.label} ${Math.round(factor.value * 100)}`)
                              .join(' · ') || '无因子'}
                          </small>
                        </div>
                      )
                    })}
                  </div>
                </details>
              )
            })}
          </div>
        )}
      </ControlPanel>
      <details
        className="technical-details"
        open={technicalOpen}
        onToggle={(event) => setTechnicalOpen(event.currentTarget.open)}
      >
        <summary>查看技术细节</summary>
        <div className="technical-details-grid">
          {Object.entries(summary.technicalLabels).map(([key, label]) => (
            <div key={key}>
              <strong>{label}</strong>
              <span>{key}</span>
            </div>
          ))}
        </div>
        <p className="control-inline-note">
          这些字段用于排查和比较；其中“建议顺序”和“参考分”不会自动改动真实路由。
        </p>
      </details>
      <ControlPanel title="需要注意的事情" note="最近 50 条">
        {state.alerts.length === 0 && failureRows.length === 0 ? (
          <ControlListEmpty label="当前没有需要处理的提醒或失败。" />
        ) : (
          <div className="control-observation-grid">
            <div>
              <h4>提醒</h4>
              {state.alerts.length === 0 ? (
                <p className="empty-note">暂无告警</p>
              ) : (
                <div className="control-event-list">
                  {state.alerts.slice(0, 12).map((item, index) => {
                    const row = asRecord(item)
                    const level = String(row.level || row.severity || row.type || 'info')
                    return (
                      <div key={index}>
                        <strong>
                          <ControlBadge tone={levelTone(level)}>
                            {alertLevelText(level)}
                          </ControlBadge>{' '}
                          {String(row.title || row.kind || 'alert')}
                          {row.count !== undefined && ` ×${String(row.count)}`}
                        </strong>
                        <span>
                          {String(row.detail || row.message || row.error || JSON.stringify(item))} ·{' '}
                          {formatDate(row.at || row.updatedAt)}
                        </span>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
            <div>
              <h4>失败渠道</h4>
              {failureRows.length === 0 ? (
                <p className="empty-note">暂无失败</p>
              ) : (
                <div className="control-event-list">
                  {failureRows.slice(0, 12).map(([provider, value]) => {
                    const row = asRecord(value)
                    const kinds = asRecord(row.kinds)
                    return (
                      <div key={provider}>
                        <strong>
                          {provider}{' '}
                          <ControlBadge tone="bad">共 {String(row.total || 0)} 次</ControlBadge>
                        </strong>
                        <span>
                          {Object.entries(kinds)
                            .slice(0, 4)
                            .map(
                              ([kind, count]) =>
                                `${kind} ×${String(asRecord(count).count || count)}`
                            )
                            .join(' · ') || JSON.stringify(value)}
                        </span>
                        {row.suggestion !== undefined && (
                          <span>建议：{String(row.suggestion)}</span>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          </div>
        )}
      </ControlPanel>
      <ControlPanel title="最近发生的请求" note={`${latestTrace.length} 次`}>
        {latestTrace.length === 0 ? (
          <ControlListEmpty label="尚未捕获请求链路。" />
        ) : (
          <div className="control-event-list">
            {latestTrace.map((item, index) => {
              const row = asRecord(item)
              const status = String(row.status || row.state || 'pending')
              const steps = asArray(row.steps)
              return (
                <details key={index}>
                  <summary>
                    <strong>
                      <ControlBadge tone={levelTone(status)}>{status}</ControlBadge>{' '}
                      {String(row.requestId || row.id || row.model || `trace-${index + 1}`)}
                    </strong>{' '}
                    <span>
                      {String(row.modelUid || row.model || '')} ·{' '}
                      {String(row.provider || row.route || '—')} ·{' '}
                      {row.durationMs !== undefined ? `${String(row.durationMs)} ms · ` : ''}
                      {formatDate(row.updatedAt || row.at)}
                    </span>
                  </summary>
                  {steps.length > 0 && (
                    <div className="control-trace-steps">
                      {steps.slice(0, 20).map((step, stepIndex) => {
                        const item = asRecord(step)
                        return (
                          <div key={stepIndex}>
                            <span>+{String(item.elapsedMs || 0)} ms</span>
                            <strong>{String(item.type || 'step')}</strong>
                            <small>
                              {Object.entries(item)
                                .filter(([key]) => !['at', 'elapsedMs', 'type'].includes(key))
                                .map(
                                  ([key, value]) =>
                                    `${key}=${typeof value === 'object' ? JSON.stringify(value) : String(value)}`
                                )
                                .join(' · ')}
                            </small>
                          </div>
                        )
                      })}
                    </div>
                  )}
                </details>
              )
            })}
          </div>
        )}
      </ControlPanel>
      <ControlPanel title="配置审计与回滚" note="高影响操作需明确选择">
        <div className="control-observation-grid">
          <div>
            <h4>审计日志</h4>
            {state.audit.length === 0 ? (
              <p className="empty-note">暂无审计动作</p>
            ) : (
              <div className="control-event-list">
                {state.audit.slice(0, 12).map((item, index) => {
                  const row = asRecord(item)
                  return (
                    <div key={index}>
                      <strong>
                        <ControlBadge tone={row.ok === false ? 'bad' : 'good'}>
                          {row.ok === false ? '失败' : '完成'}
                        </ControlBadge>{' '}
                        {String(row.action || row.type || 'change')}
                      </strong>
                      <span>
                        {formatDate(row.at || row.updatedAt)} ·{' '}
                        {String(row.target || row.path || '')}
                      </span>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
          <div>
            <h4>历史备份</h4>
            {backupOptions.length === 0 ? (
              <p className="empty-note">暂无备份</p>
            ) : (
              <>
                <select
                  value={selectedBackup}
                  onChange={(event) => setSelectedBackup(event.target.value)}
                >
                  <option value="">选择备份</option>
                  {backupOptions.map((item) => (
                    <option key={item.value} value={item.value}>
                      {item.label}
                    </option>
                  ))}
                </select>
                <div className="control-actions-row">
                  <button
                    className="control-action control-action-danger"
                    type="button"
                    disabled={busy || !selectedBackup}
                    onClick={() => void rollback()}
                  >
                    回滚所选备份
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </ControlPanel>
      <ControlPanel title="配置包与交接" note="仅读取用户主动选择的 JSON">
        <div className="control-actions-row">
          <ActionButton busy={busy} variant="primary" onClick={() => void exportPack()}>
            导出配置包
          </ActionButton>
          <label className="control-action control-action-quiet">
            导入配置包
            <input
              className="control-file-input"
              type="file"
              accept="application/json,.json"
              disabled={busy}
              onChange={(event) => {
                void importPack(event.target.files?.[0])
                event.currentTarget.value = ''
              }}
            />
          </label>
        </div>
        <p className="control-inline-note">
          文件只通过系统文件选择器交给当前组件，大小上限 8 MiB；不会扫描本地目录。
        </p>
      </ControlPanel>
      <ControlStatus message={error || status} error={Boolean(error)} />
    </ControlView>
  )
}
