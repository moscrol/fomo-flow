import { useEffect, useMemo, useState } from 'react'

import { asArray, asRecord } from '@/lib/daoControlApi'

import {
  ActionButton,
  ControlField,
  ControlListEmpty,
  ControlPanel,
  ControlStatus,
  ControlView,
  LoadingState,
  useDaoApi
} from './ControlPrimitives'
import { ControlBadge, ControlReadout, ControlReadoutGrid } from './ControlReadout'
import {
  capabilityBadges,
  formatCount,
  formatDate,
  formatTokens,
  protocolLabel
} from './controlDisplay'

type RouteRecord = Record<string, unknown>

type FamilyRecord = Record<string, unknown>

type RouteDraft = {
  modelUid: string
  provider: string
  model: string
  maxTokens: string
  temperature: string
  reasoningLevel: string
  channelStrategy: string
}

const emptyDraft: RouteDraft = {
  modelUid: '',
  provider: '',
  model: '',
  maxTokens: '16384',
  temperature: '',
  reasoningLevel: 'off',
  channelStrategy: 'priority'
}

function records(value: unknown): RouteRecord[] {
  const routes = asRecord(asRecord(value).routes)
  return Object.entries(routes).map(([uid, route]) => ({ uid, ...asRecord(route) }))
}

function providerRecords(value: unknown): Array<{ name: string; models: string[] }> {
  const providers = asRecord(asRecord(value).providers)
  return Object.entries(providers).map(([name, raw]) => {
    const provider = asRecord(raw)
    const source = Array.isArray(provider.models) ? provider.models : provider._models
    const models = asArray(source)
      .map((item) =>
        typeof item === 'string' ? item : String(asRecord(item).id || asRecord(item).model || '')
      )
      .filter(Boolean)
    return { name, models }
  })
}

function routeLabel(route: RouteRecord): string {
  const provider = String(route.provider || route.providerName || '自动选择')
  const model = String(route.model || route.upstreamModel || '渠道默认模型')
  return `${provider} / ${model}`
}

function normalizeUid(value: unknown): string {
  return String(value || '')
    .replace(/^MODEL_/i, '')
    .replace(/_/g, '-')
    .toLocaleLowerCase()
}

function familyMembers(family: FamilyRecord): FamilyRecord[] {
  return asArray(family.members).map((item) => asRecord(item))
}

function familyHasRoute(family: FamilyRecord, routes: RouteRecord[]): boolean {
  return familyMembers(family).some((member) => {
    const modelUid = member.modelUid || member.id
    return routes.some((route) => normalizeUid(route.uid) === normalizeUid(modelUid))
  })
}

function runtimeRows(value: unknown): Array<{ uid: string; row: RouteRecord }> {
  return Object.entries(asRecord(value))
    .map(([uid, raw]) => ({ uid, row: asRecord(raw) }))
    .sort((a, b) => String(b.row.updatedAt || '').localeCompare(String(a.row.updatedAt || '')))
}

export function RoutesControlView() {
  const api = useDaoApi()
  const [routes, setRoutes] = useState<RouteRecord[]>([])
  const [providers, setProviders] = useState<Array<{ name: string; models: string[] }>>([])
  const [overview, setOverview] = useState<Record<string, unknown>>({})
  const [draft, setDraft] = useState<RouteDraft>(emptyDraft)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')
  const [capability, setCapability] = useState('')
  const [familyFilter, setFamilyFilter] = useState('')
  const [externalFilter, setExternalFilter] = useState('')

  async function refresh(): Promise<void> {
    setLoading(true)
    setError('')
    try {
      const [routeRaw, providerRaw, overviewRaw] = await Promise.all([
        api.request('/origin/ea/routes'),
        api.request('/origin/ea/providers'),
        api.request('/origin/ea/overview')
      ])
      setRoutes(records(routeRaw))
      setProviders(providerRecords(providerRaw))
      setOverview(asRecord(overviewRaw))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '路由读取失败')
    } finally {
      setLoading(false)
    }
  }

  async function refreshRuntime(): Promise<void> {
    try {
      setOverview(asRecord(await api.request('/origin/ea/overview')))
    } catch {
      // Keep the last known route projection when the runtime is between reloads.
    }
  }

  useEffect(() => {
    void refresh()
    const timer = window.setInterval(() => void refreshRuntime(), 5_000)
    return () => window.clearInterval(timer)
  }, [])

  const selectedProvider = useMemo(
    () => providers.find((provider) => provider.name === draft.provider),
    [providers, draft.provider]
  )
  const families = asArray(overview.official_families).map((item) => asRecord(item) as FamilyRecord)
  const runtime = runtimeRows(overview.route_runtime)
  const bridgeRoutes = routes.filter((route) => route._bridgeManaged === true)
  const filteredFamilies = useMemo(() => {
    const query = familyFilter.trim().toLocaleLowerCase()
    if (!query) return families
    return families.filter((family) => {
      const text = [
        family.familyUid,
        family.label,
        family.provider,
        ...familyMembers(family).map((member) => member.modelUid || member.id)
      ]
        .join(' ')
        .toLocaleLowerCase()
      return text.includes(query)
    })
  }, [families, familyFilter])
  const filteredExternalProviders = useMemo(() => {
    const query = externalFilter.trim().toLocaleLowerCase()
    if (!query) return providers
    return providers.filter((provider) =>
      `${provider.name} ${provider.models.join(' ')}`.toLocaleLowerCase().includes(query)
    )
  }, [providers, externalFilter])
  const routedFamilyCount = families.filter((family) => familyHasRoute(family, routes)).length
  const routedMemberCount = families.reduce(
    (sum, family) =>
      sum +
      familyMembers(family).filter((member) => {
        const modelUid = member.modelUid || member.id
        return routes.some((route) => normalizeUid(route.uid) === normalizeUid(modelUid))
      }).length,
    0
  )
  const routerReady = overview.router_ready === true

  function editRoute(route: RouteRecord): void {
    setDraft({
      modelUid: String(route.uid || ''),
      provider: String(route.provider || ''),
      model: String(route.model || route.upstreamModel || ''),
      maxTokens: String(route.maxTokens || route.max_output_tokens || '16384'),
      temperature: route.temperature === undefined ? '' : String(route.temperature),
      reasoningLevel: String(route.reasoningLevel || route.reasoningEffort || 'off'),
      channelStrategy: String(route.channelStrategy || 'priority')
    })
    setStatus(`正在编辑 ${String(route.uid || '')}`)
  }

  async function saveRoute(): Promise<void> {
    if (!draft.modelUid.trim()) {
      setError('模型 UID 必填')
      return
    }
    if (!draft.provider.trim() || !draft.model.trim()) {
      setError('请选择 Provider 和上游模型')
      return
    }
    setBusy(true)
    setError('')
    try {
      const route: Record<string, unknown> = {
        provider: draft.provider,
        model: draft.model,
        maxTokens: Number(draft.maxTokens) || 16384,
        reasoningLevel: draft.reasoningLevel || 'off',
        channelStrategy: draft.channelStrategy || 'priority'
      }
      if (draft.temperature.trim()) route.temperature = Number(draft.temperature)
      await api.request('/origin/ea/route', 'POST', { modelUid: draft.modelUid.trim(), route })
      setStatus(`路由 ${draft.modelUid.trim()} 已保存`)
      await refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '路由保存失败')
    } finally {
      setBusy(false)
    }
  }

  async function deleteRoute(route: RouteRecord): Promise<void> {
    const uid = String(route.uid || '')
    if (!uid) return
    setBusy(true)
    setError('')
    try {
      await api.request(`/origin/ea/route/${encodeURIComponent(uid)}`, 'DELETE')
      setStatus(`路由 ${uid} 已删除`)
      await refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '路由删除失败')
    } finally {
      setBusy(false)
    }
  }

  async function probeCapability(): Promise<void> {
    if (!draft.provider || !draft.model) {
      setError('先选择 Provider 和上游模型')
      return
    }
    setBusy(true)
    setError('')
    try {
      const result = asRecord(
        await api.request(
          `/origin/ea/model-capability?provider=${encodeURIComponent(draft.provider)}&model=${encodeURIComponent(draft.model)}`
        )
      )
      setCapability(JSON.stringify(result.capability || result, null, 2))
      setStatus('模型能力已探取')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '模型能力探取失败')
    } finally {
      setBusy(false)
    }
  }

  async function setReasoning(route: RouteRecord, reasoningLevel: string): Promise<void> {
    const uid = String(route.uid || '')
    setBusy(true)
    setError('')
    try {
      await api.request('/origin/ea/reasoning', 'POST', { modelUid: uid, reasoningLevel })
      setStatus(`${uid} 的思考强度已切换为 ${reasoningLevel}`)
      await refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '思考强度切换失败')
    } finally {
      setBusy(false)
    }
  }

  if (loading && routes.length === 0) return <LoadingState label="正在加载模型路由…" />

  return (
    <ControlView
      eyebrow="ROUTES / 路由"
      title="模型路由"
      description="把官方模型 UID 映射到具体渠道和上游模型，支持热保存、思考强度和故障转移策略。"
      onRefresh={() => void refresh()}
      loading={loading || busy}
    >
      <div className="metric-row">
        <article className="metric-card">
          <span>路由数</span>
          <strong>{routes.length}</strong>
          <small>运行时当前配置</small>
        </article>
        <article className="metric-card">
          <span>已绑定渠道</span>
          <strong>{routes.filter((route) => route.provider).length}</strong>
          <small>明确指定上游</small>
        </article>
        <article className="metric-card">
          <span>官方模型族</span>
          <strong>{families.length || '—'}</strong>
          <small>{routedFamilyCount} 族已接入自定义渠道</small>
        </article>
        <article className="metric-card">
          <span>路由器</span>
          <strong>{routerReady ? 'READY' : '待命'}</strong>
          <small>{bridgeRoutes.length} 条协议桥同步路由</small>
        </article>
      </div>

      <ControlPanel title="当前实际路由" note="请求命中后自动留下运行记录">
        {runtime.length === 0 ? (
          <ControlReadoutGrid>
            <ControlReadout
              label="运行记录"
              value="尚无请求"
              detail="配置路由会在首次真实调用后显示实际渠道"
              tone="muted"
            />
            <ControlReadout
              label="官方已接入"
              value={`${routedFamilyCount}/${families.length || '—'}`}
              detail={`${formatCount(routedMemberCount)} 个档位有明确路由`}
              tone={routedFamilyCount ? 'brand' : 'muted'}
            />
            <ControlReadout
              label="路由器状态"
              value={routerReady ? 'READY' : 'STANDBY'}
              detail="来自 /origin/ea/overview"
              tone={routerReady ? 'good' : 'warn'}
            />
            <ControlReadout
              label="故障转移"
              value={formatCount(
                routes.filter((route) => route.channelStrategy === 'random').length
              )}
              detail="随机首选会话"
            />
          </ControlReadoutGrid>
        ) : (
          <div className="control-event-list">
            {runtime.slice(0, 8).map(({ uid, row }) => {
              const failed = row.state === 'failed'
              const fallback = row.fallback === true
              return (
                <div key={uid}>
                  <strong>
                    {uid}{' '}
                    <ControlBadge tone={failed ? 'bad' : fallback ? 'warn' : 'good'}>
                      {failed ? '全部渠道失败' : fallback ? '备用接管' : '主渠道'}
                    </ControlBadge>
                  </strong>
                  <span>
                    {String(row.provider || '—')} / {String(row.model || '—')} ·{' '}
                    {protocolLabel(row.protocol)} · 思考 {String(row.reasoningLevel || '模型默认')}{' '}
                    · {formatDate(row.updatedAt)}
                  </span>
                </div>
              )
            })}
          </div>
        )}
      </ControlPanel>

      <ControlPanel
        title="官方模型族目录"
        note={`${filteredFamilies.length}/${families.length || 0} 族`}
      >
        <div className="control-actions-row">
          <input
            className="control-filter"
            value={familyFilter}
            onChange={(event) => setFamilyFilter(event.target.value)}
            placeholder="筛选官方模型族 / 档位 / 厂商"
          />
        </div>
        {filteredFamilies.length === 0 ? (
          <ControlListEmpty label="没有匹配的官方模型族，或运行时尚未返回目录。" />
        ) : (
          <div className="control-record-list route-family-list">
            {filteredFamilies.map((family, index) => {
              const familyUid = String(family.familyUid || family.uid || `family-${index}`)
              const members = familyMembers(family)
              const routed = familyHasRoute(family, routes)
              const defaultMember =
                members.find((member) => member.isDefault === true) || members[0]
              return (
                <article className="control-record-row" key={familyUid}>
                  <div className="control-record-main">
                    <div>
                      <strong>
                        {String(family.label || familyUid)}{' '}
                        {family.isRecommended === true && (
                          <ControlBadge tone="brand">推荐</ControlBadge>
                        )}{' '}
                        {family.isNew === true && <ControlBadge tone="good">NEW</ControlBadge>}
                        <ControlBadge tone={routed ? 'good' : 'muted'}>
                          {routed ? '已路由' : '官方直通'}
                        </ControlBadge>
                      </strong>
                      <small>
                        {familyUid} · {String(family.provider || '官方')} · {members.length} 档 ·
                        默认 {String(defaultMember?.modelUid || defaultMember?.id || '—')}
                      </small>
                      <small>
                        {members
                          .slice(0, 6)
                          .map((member) => String(member.modelUid || member.id || ''))
                          .filter(Boolean)
                          .join(' · ')}
                        {members.length > 6 ? ` · +${members.length - 6}` : ''}
                      </small>
                    </div>
                  </div>
                </article>
              )
            })}
          </div>
        )}
      </ControlPanel>

      <ControlPanel
        title="外接模型目录"
        note={`${filteredExternalProviders.length}/${providers.length} 个渠道`}
      >
        <div className="control-actions-row">
          <input
            className="control-filter"
            value={externalFilter}
            onChange={(event) => setExternalFilter(event.target.value)}
            placeholder="筛选 Provider / 上游模型"
          />
        </div>
        {filteredExternalProviders.length === 0 ? (
          <ControlListEmpty label="尚未加载外接模型目录。" />
        ) : (
          <div className="control-record-list route-external-list">
            {filteredExternalProviders.map((provider) => {
              const providerRoutes = routes.filter(
                (route) => String(route.provider || route.providerName || '') === provider.name
              )
              return (
                <article className="control-record-row" key={provider.name}>
                  <div className="control-record-main">
                    <div>
                      <strong>
                        {provider.name}{' '}
                        <ControlBadge tone={providerRoutes.length ? 'good' : 'muted'}>
                          {providerRoutes.length ? `${providerRoutes.length} 条路由` : '未被路由'}
                        </ControlBadge>
                      </strong>
                      <small>{provider.models.length} 个模型 · 当前目录缓存</small>
                      <small>
                        {provider.models.slice(0, 10).join(' · ')}
                        {provider.models.length > 10 ? ` · +${provider.models.length - 10}` : ''}
                      </small>
                    </div>
                  </div>
                </article>
              )
            })}
          </div>
        )}
      </ControlPanel>

      {bridgeRoutes.length > 0 && (
        <ControlPanel title="协议中转同步路由" note={`${bridgeRoutes.length} 条`}>
          <div className="control-event-list">
            {bridgeRoutes.map((route) => (
              <div key={String(route.uid)}>
                <strong>{String(route.uid)}</strong>
                <span>
                  {routeLabel(route)} · 对外协议{' '}
                  {asArray(route._targetProtocols).map(protocolLabel).join(' + ') || '自动'}
                </span>
              </div>
            ))}
          </div>
        </ControlPanel>
      )}

      <ControlPanel title="添加或更新路由" note="热更新">
        <div className="control-form-grid">
          <ControlField label="模型 UID">
            <input
              value={draft.modelUid}
              onChange={(event) => setDraft({ ...draft, modelUid: event.target.value })}
              placeholder="如 MODEL_SWE_1_6_FAST"
            />
          </ControlField>
          <ControlField label="Provider">
            <select
              value={draft.provider}
              onChange={(event) => setDraft({ ...draft, provider: event.target.value, model: '' })}
            >
              <option value="">选择渠道</option>
              {providers.map((provider) => (
                <option key={provider.name} value={provider.name}>
                  {provider.name}
                </option>
              ))}
            </select>
          </ControlField>
          <ControlField label="上游模型">
            <select
              value={draft.model}
              onChange={(event) => setDraft({ ...draft, model: event.target.value })}
            >
              <option value="">选择或先探测</option>
              {(selectedProvider?.models || []).map((model) => (
                <option key={model} value={model}>
                  {model}
                </option>
              ))}
            </select>
          </ControlField>
          <ControlField label="最大输出 Token">
            <input
              type="number"
              min="1"
              value={draft.maxTokens}
              onChange={(event) => setDraft({ ...draft, maxTokens: event.target.value })}
            />
          </ControlField>
          <ControlField label="Temperature">
            <input
              type="number"
              min="0"
              max="2"
              step="0.1"
              value={draft.temperature}
              onChange={(event) => setDraft({ ...draft, temperature: event.target.value })}
              placeholder="留空=默认"
            />
          </ControlField>
          <ControlField label="思考强度">
            <select
              value={draft.reasoningLevel}
              onChange={(event) => setDraft({ ...draft, reasoningLevel: event.target.value })}
            >
              {['off', 'low', 'medium', 'high', 'xhigh'].map((level) => (
                <option key={level} value={level}>
                  {level}
                </option>
              ))}
            </select>
          </ControlField>
          <ControlField label="渠道策略">
            <select
              value={draft.channelStrategy}
              onChange={(event) => setDraft({ ...draft, channelStrategy: event.target.value })}
            >
              <option value="priority">按优先级故障转移</option>
              <option value="random">随机首选（会话内保持）</option>
            </select>
          </ControlField>
        </div>
        <div className="control-actions-row">
          <ActionButton busy={busy} variant="primary" onClick={() => void saveRoute()}>
            保存路由
          </ActionButton>
          <button
            className="control-action control-action-secondary"
            type="button"
            disabled={busy}
            onClick={() => void probeCapability()}
          >
            探取模型能力
          </button>
          <button
            className="control-action control-action-quiet"
            type="button"
            onClick={() => {
              setDraft(emptyDraft)
              setStatus('已清空路由编辑器')
            }}
          >
            新建
          </button>
        </div>
        {capability && <pre className="control-preview">{capability}</pre>}
      </ControlPanel>

      <ControlPanel title="已配置路由" note={`${routes.length} 条`}>
        {routes.length === 0 ? (
          <ControlListEmpty label="还没有路由配置。" />
        ) : (
          <div className="control-record-list">
            {routes.map((route) => {
              const uid = String(route.uid || '')
              const level = String(route.reasoningLevel || route.reasoningEffort || 'off')
              return (
                <article className="control-record-row" key={uid}>
                  <div className="control-record-main">
                    <div>
                      <strong>
                        {uid}{' '}
                        {Boolean(route._customModelRef) && (
                          <ControlBadge tone="brand">⑦ 自定义</ControlBadge>
                        )}{' '}
                        {route._bridgeManaged === true && (
                          <ControlBadge tone="brand">⑥ 中转</ControlBadge>
                        )}
                      </strong>
                      <small>{routeLabel(route)}</small>
                      <small>
                        {route.channelStrategy === 'random' ? '随机首选' : '优先级故障转移'} ·
                        最大输出 {formatTokens(route.maxTokens || route.max_output_tokens || null)}{' '}
                        · {protocolLabel(route.protocol || route.sourceProtocol)}
                      </small>
                      <span className="control-badge-row">
                        {capabilityBadges(route.capabilities).map((badge) => (
                          <ControlBadge key={badge} tone="muted">
                            {badge}
                          </ControlBadge>
                        ))}
                      </span>
                    </div>
                  </div>
                  <div className="control-record-actions">
                    <select
                      aria-label={`${uid} 思考强度`}
                      value={level}
                      disabled={busy}
                      onChange={(event) => void setReasoning(route, event.target.value)}
                    >
                      {['off', 'low', 'medium', 'high', 'xhigh'].map((item) => (
                        <option key={item} value={item}>
                          {item}
                        </option>
                      ))}
                    </select>
                    <button
                      className="control-action control-action-quiet"
                      type="button"
                      disabled={busy}
                      onClick={() => editRoute(route)}
                    >
                      编辑
                    </button>
                    <button
                      className="control-action control-action-danger"
                      type="button"
                      disabled={busy}
                      onClick={() => void deleteRoute(route)}
                    >
                      删除
                    </button>
                  </div>
                </article>
              )
            })}
          </div>
        )}
      </ControlPanel>
      <ControlStatus message={error || status} error={Boolean(error)} />
    </ControlView>
  )
}
