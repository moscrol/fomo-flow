import { useEffect, useRef, useState, type FormEvent } from 'react'

import {
  projectDecisionInbox,
  projectDecisionModelOptions,
  projectPreflight,
  projectRouteEvidence,
  summarizeDecisionCenter,
  summarizePreflight,
  type DecisionCandidate,
  type DecisionInboxItem,
  type DecisionModelOption,
  type DecisionPreflight,
  type RouteEvidence
} from '@/lib/decisionCenter'
import type { RoutingProfileId } from '@/lib/routingDecision'
import { projectRouteRelay, type RouteRelayHop } from '@/lib/routeRelay'
import type { DaoViewId } from '@/lib/views'

import {
  ActionButton,
  ControlField,
  ControlListEmpty,
  ControlPanel,
  ControlStatus,
  ControlView,
  useDaoApi
} from './ControlPrimitives'
import { formatDate } from './controlDisplay'
import { RouteRelaySheet } from './RouteRelaySheet'

const PROFILE_OPTIONS: Array<{ value: RoutingProfileId; label: string }> = [
  { value: 'balanced', label: '日常均衡' },
  { value: 'coding', label: '写代码' },
  { value: 'fast', label: '尽快回复' },
  { value: 'cheap', label: '控制成本' },
  { value: 'reliable', label: '稳定优先' },
  { value: 'offline', label: '离线优先' }
]

const BUDGET_OPTIONS = [
  { value: '', label: '不设预算' },
  { value: '0.01', label: '$0.01' },
  { value: '0.05', label: '$0.05' },
  { value: '0.2', label: '$0.20' },
  { value: '1', label: '$1.00' }
] as const

export function DecisionCenterControlView({ onNavigate }: { onNavigate(view: DaoViewId): void }) {
  const api = useDaoApi()
  const [model, setModel] = useState('')
  const [profile, setProfile] = useState<RoutingProfileId>('balanced')
  const [budget, setBudget] = useState('')
  const [modelOptions, setModelOptions] = useState<DecisionModelOption[]>([])
  const [routesUnavailable, setRoutesUnavailable] = useState(false)
  const [preflight, setPreflight] = useState<DecisionPreflight | null>(null)
  const [relayHops, setRelayHops] = useState<RouteRelayHop[]>([])
  const [inbox, setInbox] = useState<DecisionInboxItem[]>([])
  const [evidence, setEvidence] = useState<RouteEvidence[]>([])
  const [selectedEvidenceId, setSelectedEvidenceId] = useState('')
  const [loading, setLoading] = useState(true)
  const [preflighting, setPreflighting] = useState(false)
  const [status, setStatus] = useState('')
  const [error, setError] = useState(false)
  const refreshSeq = useRef(0)
  const preflightSeq = useRef(0)
  const selectedModel = useRef('')
  const mounted = useRef(true)

  async function refresh(): Promise<void> {
    const seq = ++refreshSeq.current
    const isCurrent = () => seq === refreshSeq.current
    setError(false)
    setStatus('')
    try {
      const [inboxPayload, evidencePayload, routesResult] = await Promise.all([
        api.request('/origin/ea/decision-inbox?limit=50'),
        api.request('/origin/ea/route-evidence?limit=50'),
        api
          .request('/origin/ea/routes')
          .then((payload) => ({ ok: true as const, payload }))
          .catch(() => ({ ok: false as const, payload: null }))
      ])
      if (!isCurrent()) return
      setInbox(projectDecisionInbox(inboxPayload))
      setEvidence(projectRouteEvidence(evidencePayload))
      const nextOptions = routesResult.ok ? projectDecisionModelOptions(routesResult.payload) : []
      setModelOptions(nextOptions)
      setRoutesUnavailable(!routesResult.ok)
      const nextModel = nextOptions.some((option) => option.value === selectedModel.current)
        ? selectedModel.current
        : (nextOptions[0]?.value ?? '')
      if (nextModel !== selectedModel.current) {
        selectedModel.current = nextModel
        clearPreflightResult()
      }
      setModel(nextModel)
    } catch {
      if (!isCurrent()) return
      setError(true)
      setStatus('决策数据暂时无法读取，稍后将自动重试。')
    } finally {
      if (isCurrent()) setLoading(false)
    }
  }

  useEffect(() => {
    mounted.current = true
    void refresh()
    const timer = window.setInterval(() => void refresh(), 10_000)
    return () => {
      mounted.current = false
      refreshSeq.current += 1
      preflightSeq.current += 1
      window.clearInterval(timer)
    }
  }, [])

  function clearPreflightResult(): void {
    preflightSeq.current += 1
    setPreflight(null)
    setRelayHops([])
    setPreflighting(false)
  }

  async function submitPreflight(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (!model || !modelOptions.some((option) => option.value === model)) {
      setError(true)
      setStatus('请先选择一个已配置模型。')
      return
    }
    clearPreflightResult()
    const seq = preflightSeq.current
    const isCurrent = () => mounted.current && seq === preflightSeq.current
    setPreflighting(true)
    setError(false)
    setStatus('')
    try {
      const parsedBudget = budget === '' ? undefined : Number(budget)
      const payload = await api.request('/origin/ea/route-preflight', 'POST', {
        model,
        profile,
        ...(parsedBudget === undefined
          ? {}
          : { budgetUsd: parsedBudget, budgetFallback: 'strict' }),
        stream: true,
        usesTools: false,
        thinkingEnabled: false
      })
      const projected = projectPreflight(payload)
      const projectedRelay = projectRouteRelay(payload)
      if (!isCurrent()) return
      if (!projected) throw new Error('invalid preflight')
      setPreflight(projected)
      setRelayHops(projectedRelay)
    } catch {
      if (!isCurrent()) return
      setError(true)
      setStatus('发送前检查暂时失败，请稍后重试。')
    } finally {
      if (isCurrent()) setPreflighting(false)
    }
  }

  async function updateDecision(item: DecisionInboxItem, action: 'ack' | 'snooze') {
    setError(false)
    setStatus('')
    try {
      await api.request(
        `/origin/ea/decision-inbox/${item.id}/${action}`,
        'POST',
        action === 'ack' ? {} : { minutes: 60 }
      )
      if (!mounted.current) return
      setInbox((items) => items.filter((candidate) => candidate.id !== item.id))
      setStatus(action === 'ack' ? '已标记为知晓。' : '已稍后提醒。')
    } catch {
      if (!mounted.current) return
      setError(true)
      setStatus('操作没有保存，请稍后重试。')
    }
  }

  const selectedEvidence =
    evidence.find((item) => item.id === selectedEvidenceId) ?? evidence[0] ?? null
  const evidenceIds = new Set(evidence.map((item) => item.id))
  const summary = summarizeDecisionCenter(inbox, evidence)

  return (
    <ControlView
      eyebrow="DAO ROUTE OBSERVATION"
      title="路由观察与处理"
      description="看看最近请求实际走了哪里；只有出现异常时才需要处理。"
      onRefresh={() => void refresh()}
      loading={loading}
    >
      <div className="decision-center-stack">
        <ControlPanel title="现在要不要处理" note={`${summary.openCount} 项待处理`}>
          <div className={`decision-center-summary tone-${summary.tone}`} aria-label="路由状态结论">
            <div>
              <strong>{summary.title}</strong>
              <p>{summary.message}</p>
            </div>
            <dl>
              <div>
                <dt>最近结果</dt>
                <dd>{summary.latestOutcome}</dd>
              </div>
              <div>
                <dt>最近渠道 / 模型</dt>
                <dd>{summary.latestRoute}</dd>
              </div>
            </dl>
          </div>
          {inbox.length === 0 ? (
            <p className="decision-center-normal-note">现在不用做任何操作。</p>
          ) : (
            <div className="decision-center-inbox" role="list">
              {inbox.map((item) => (
                <article
                  className={`decision-center-inbox-item tone-${item.severity}`}
                  key={item.id}
                  role="listitem"
                >
                  <div>
                    <h4>{item.title}</h4>
                    <p>{item.message}</p>
                    <small>近期待处理 {item.count} 次</small>
                  </div>
                  <div className="decision-center-actions">
                    {item.evidenceId && evidenceIds.has(item.evidenceId) ? (
                      <ActionButton onClick={() => setSelectedEvidenceId(item.evidenceId ?? '')}>
                        查看证据
                      </ActionButton>
                    ) : item.evidenceId ? (
                      <small className="decision-center-evidence-expired">
                        详细证据已按保留期限退役
                      </small>
                    ) : null}
                    <ActionButton onClick={() => void updateDecision(item, 'snooze')}>
                      一小时后提醒
                    </ActionButton>
                    <ActionButton onClick={() => void updateDecision(item, 'ack')}>
                      {`已知晓：${item.title}`}
                    </ActionButton>
                  </div>
                </article>
              ))}
            </div>
          )}
          <div className="decision-center-route-action">
            <ActionButton onClick={() => onNavigate('routes')}>打开路由配置</ActionButton>
          </div>
        </ControlPanel>

        <ControlPanel title="最近请求走了哪里" note={`${evidence.length} 条真实记录`}>
          {selectedEvidence ? (
            <>
              <div className="decision-center-evidence-picker" role="list">
                {evidence.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className={item.id === selectedEvidence.id ? 'is-selected' : ''}
                    aria-pressed={item.id === selectedEvidence.id}
                    onClick={() => setSelectedEvidenceId(item.id)}
                  >
                    <small>{formatDate(item.createdAt)}</small>
                    <strong>{item.outcome ? candidateName(item.outcome) : '结果尚未记录'}</strong>
                    <span>{item.outcome?.label || '查看路由过程'}</span>
                  </button>
                ))}
              </div>
              <EvidenceTimeline evidence={selectedEvidence} />
            </>
          ) : (
            <ControlListEmpty label="还没有真实请求记录。发起一次经由 FOMO FLOW 的请求后，这里会显示实际渠道和模型。" />
          )}
        </ControlPanel>

        <details className="decision-center-check">
          <summary>
            <span>
              <strong>发送前检查（可选）</strong>
              <small>日常使用不需要；准备改路由或预算时再检查。</small>
            </span>
          </summary>
          <div className="decision-center-check-body">
            <p className="decision-center-advisory">
              只计算预计路线，不会发送真实请求、调用渠道或改变规定优先级。
            </p>
            <form
              className="decision-center-form"
              onSubmit={(event) => void submitPreflight(event)}
            >
              <div className="control-form-grid">
                <ControlField label="已配置模型">
                  <select
                    value={model}
                    disabled={modelOptions.length === 0}
                    onChange={(event) => {
                      selectedModel.current = event.target.value
                      clearPreflightResult()
                      setModel(event.target.value)
                    }}
                  >
                    {modelOptions.length === 0 && <option value="">暂无可选模型</option>}
                    {modelOptions.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </ControlField>
                <ControlField label="使用用途">
                  <select
                    value={profile}
                    onChange={(event) => {
                      clearPreflightResult()
                      setProfile(event.target.value as RoutingProfileId)
                    }}
                  >
                    {PROFILE_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </ControlField>
                <ControlField label="预算上限">
                  <select
                    value={budget}
                    onChange={(event) => {
                      clearPreflightResult()
                      setBudget(event.target.value)
                    }}
                  >
                    {BUDGET_OPTIONS.map((option) => (
                      <option key={option.value || 'none'} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </ControlField>
              </div>
              <button
                type="submit"
                className="control-action control-action-primary"
                disabled={preflighting || modelOptions.length === 0}
              >
                {preflighting ? '正在检查…' : '查看预计路线'}
              </button>
            </form>
            {modelOptions.length === 0 && (
              <div className="decision-center-no-routes">
                <p>
                  {routesUnavailable
                    ? '已配置模型暂时无法读取，日常路由观察仍可继续。'
                    : '还没有可供检查的已配置模型。'}
                </p>
                <ActionButton onClick={() => onNavigate('routes')}>打开路由配置</ActionButton>
              </div>
            )}
            {preflight && <PreflightResult preflight={preflight} relayHops={relayHops} />}
          </div>
        </details>
      </div>
      {status && (
        <div role="status">
          <ControlStatus message={status} error={error} />
        </div>
      )}
    </ControlView>
  )
}

function PreflightResult({
  preflight,
  relayHops
}: {
  preflight: DecisionPreflight
  relayHops: RouteRelayHop[]
}) {
  const summary = summarizePreflight(preflight)
  return (
    <div className="decision-center-preflight">
      <div className={`decision-center-preflight-summary tone-${summary.tone}`} aria-live="polite">
        <strong>{summary.title}</strong>
        <p>{summary.message}</p>
      </div>
      <p className="decision-center-advisory">{preflight.message}</p>
      <RouteRelaySheet hops={relayHops} />
      <details className="decision-center-plan-details">
        <summary>查看详细顺序</summary>
        <div className="decision-center-plan-grid">
          <CandidateList
            title="规定顺序"
            candidates={preflight.configuredOrder}
            label="实际优先级"
          />
          <CandidateList
            title="预计实际尝试"
            candidates={preflight.dispatchOrder}
            label="尝试顺序"
          />
          <CandidateList title="参考建议" candidates={preflight.advisoryOrder} label="建议" />
        </div>
        {preflight.excluded.length > 0 && (
          <div className="decision-center-excluded">
            <h4>本次不会尝试</h4>
            <ul>
              {preflight.excluded.map((item) => (
                <li key={`${candidateKey(item)}:${item.reason}`}>
                  {candidateName(item)} · {item.reasonLabel}
                </li>
              ))}
            </ul>
          </div>
        )}
      </details>
    </div>
  )
}

function CandidateList({
  title,
  candidates,
  label
}: {
  title: string
  candidates: DecisionCandidate[]
  label: string
}) {
  return (
    <section className="decision-center-candidate-list">
      <h4>{title}</h4>
      {candidates.length === 0 ? (
        <p className="empty-note">没有可显示的渠道。</p>
      ) : (
        <ol>
          {candidates.map((item, index) => (
            <li key={candidateKey(item)}>
              {label === '尝试顺序' ? `${label} ${index + 1}` : `${label} #${index + 1}`}{' '}
              {candidateName(item)}
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}

function EvidenceTimeline({ evidence }: { evidence: RouteEvidence }) {
  return (
    <div className="decision-center-evidence">
      <p>
        {evidence.linkedPreflight
          ? '这次真实请求与一次发送前检查成功关联。'
          : '这次请求直接按实时配置执行。'}
      </p>
      <ol className="decision-center-timeline">
        {evidence.events.map((event) => (
          <li
            className={['fallback', 'skip', 'plan_drift'].includes(event.kind) ? 'is-risk' : ''}
            key={`${event.at}:${event.kind}:${event.provider}:${event.model}`}
          >
            <strong>{evidenceEventLabel(event.kind)}</strong>
            <span>{candidateName(event)}</span>
            {event.reasonLabel && <small>{event.reasonLabel}</small>}
            {event.outcomeLabel && <small>{event.outcomeLabel}</small>}
            {event.status && <small>HTTP {event.status}</small>}
          </li>
        ))}
      </ol>
      {evidence.outcome && (
        <p className="decision-center-outcome">
          最终结果：{evidence.outcome.label}
          {evidence.outcome.provider ? ` · ${candidateName(evidence.outcome)}` : ''}
        </p>
      )}
    </div>
  )
}

function candidateName(item: { provider: string; model: string }): string {
  return [item.provider, item.model].filter(Boolean).join(' · ') || '未命名渠道'
}

function candidateKey(item: DecisionCandidate): string {
  return [item.provider, item.model, item.source, item.actualPriority, item.advisoryRank].join(':')
}

function evidenceEventLabel(kind: string): string {
  const labels: Record<string, string> = {
    plan: '确定本次计划',
    plan_drift: '预演后事实变化',
    attempt: '尝试渠道',
    fallback: '转向后备渠道',
    skip: '跳过渠道',
    outcome: '记录最终结果'
  }
  return labels[kind] || '路由事件'
}
