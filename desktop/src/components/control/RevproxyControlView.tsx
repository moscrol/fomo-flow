import { useEffect, useMemo, useState } from 'react'

import { asArray, asRecord } from '@/lib/daoControlApi'
import { desktopHost } from '@/lib/desktopHost'

import {
  ActionButton,
  ControlField,
  ControlListEmpty,
  ControlPanel,
  ControlStatus,
  ControlToggle,
  ControlView,
  LoadingState,
  useDaoApi
} from './ControlPrimitives'
import { ControlBadge } from './ControlReadout'
import { capabilityBadges, formatCount, formatTokens, protocolLabel } from './controlDisplay'

type ModelRecord = Record<string, unknown> & { id?: string; exposed?: boolean }
type FamilyRecord = Record<string, unknown> & {
  uid?: string
  familyUid?: string
  label?: string
  familyLabel?: string
  members?: unknown[]
}

type ProxyDraft = {
  enabled: boolean
  applyInvert: boolean
  isolatePrompt: boolean
  exposeLan: boolean
  defaultMaxTokens: string
}

const initialDraft: ProxyDraft = {
  enabled: false,
  applyInvert: true,
  isolatePrompt: true,
  exposeLan: false,
  defaultMaxTokens: '16384'
}

function modelsOf(value: unknown): ModelRecord[] {
  return asArray(asRecord(value).models)
    .map((item) => asRecord(item) as ModelRecord)
    .filter((item) => item.id)
}

function familiesOf(value: unknown): FamilyRecord[] {
  return asArray(asRecord(value).families).map((item) => asRecord(item) as FamilyRecord)
}

function maskedKey(value: unknown): string {
  const key = String(value || '')
  if (!key) return '未生成'
  if (/[•*…]/.test(key) || key.includes('...')) return key
  if (key.length <= 8) return `${key.slice(0, 2)}••••`
  return `${key.slice(0, 6)}••••${key.slice(-3)}`
}

function modelTone(model: ModelRecord): 'good' | 'warn' | 'bad' | 'muted' {
  if (model.exposed === false || model.availableNow === false) return 'muted'
  if (model.color === 'red' || model.status === 'failed') return 'bad'
  if (model.color === 'amber' || model.status === 'premium') return 'warn'
  if (model.color === 'green' || model.status === 'channel' || model.status === 'free')
    return 'good'
  return 'muted'
}

function protocolEndpoints(value: unknown): Array<{ protocol: string; endpoint: string }> {
  const endpoints = asRecord(value)
  return [
    ['openai-chat', endpoints.openaiChat],
    ['openai-responses', endpoints.openaiResponses],
    ['anthropic', endpoints.anthropic],
    ['gemini', endpoints.gemini]
  ]
    .filter(([, endpoint]) => endpoint)
    .map(([protocol, endpoint]) => ({ protocol: String(protocol), endpoint: String(endpoint) }))
}

function quotaLabel(value: unknown): string {
  const text = String(value || '').trim()
  return !text || text.toLocaleLowerCase() === 'unknown' ? '配额未探测' : text
}

export function RevproxyControlView() {
  const api = useDaoApi()
  const [raw, setRaw] = useState<Record<string, unknown>>({})
  const [models, setModels] = useState<ModelRecord[]>([])
  const [families, setFamilies] = useState<FamilyRecord[]>([])
  const [tiers, setTiers] = useState<Record<string, unknown>>({})
  const [draft, setDraft] = useState(initialDraft)
  const [filter, setFilter] = useState('')
  const [protocol, setProtocol] = useState('openai-chat')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')

  async function refresh(): Promise<void> {
    setLoading(true)
    setError('')
    try {
      const next = asRecord(await api.request('/origin/revproxy/status'))
      // The Web compatibility page can offer an explicit key copy action. The
      // native presentation only needs hasKey and keeps the secret out of
      // renderer state altogether.
      const safe = { ...next }
      if (next.hasKey === true && next.apiKey) {
        safe.apiKey = maskedKey(next.apiKey)
      } else {
        delete safe.apiKey
      }
      setRaw(safe)
      setModels(modelsOf(next))
      setFamilies(familiesOf(next))
      setTiers(asRecord(next.tiers))
      setDraft({
        enabled: next.enabled === true,
        applyInvert: next.applyInvert !== false,
        isolatePrompt: next.isolatePrompt !== false,
        exposeLan: next.exposeLan === true,
        defaultMaxTokens: String(next.defaultMaxTokens || '16384')
      })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '反代状态读取失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void refresh()
  }, [])

  const filteredModels = useMemo(() => {
    const query = filter.trim().toLocaleLowerCase()
    return query
      ? models.filter((model) => JSON.stringify(model).toLocaleLowerCase().includes(query))
      : models
  }, [models, filter])
  const stats = asRecord(raw.stats)
  const exposedCount = models.filter((model) => model.exposed !== false).length
  const endpointRows = protocolEndpoints(raw.endpoints)
  const supportedProtocols = asArray(raw.supportedProtocols).map(String)
  const greenCount = Number(stats.green) || models.filter((model) => model.color === 'green').length
  const amberCount = Number(stats.amber) || models.filter((model) => model.color === 'amber').length
  const redCount = Number(stats.red) || models.filter((model) => model.color === 'red').length

  async function saveConfig(regenerateKey = false): Promise<void> {
    setBusy(true)
    setError('')
    try {
      await api.request('/origin/revproxy/config', 'POST', {
        ...draft,
        defaultMaxTokens: Number(draft.defaultMaxTokens) || 16384,
        regenerateKey
      })
      setStatus(regenerateKey ? '反代配置已保存并重新生成 Key' : '反代配置已热更新')
      await refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '反代配置保存失败')
    } finally {
      setBusy(false)
    }
  }

  async function setAll(exposed: boolean): Promise<void> {
    setBusy(true)
    setError('')
    try {
      await api.request('/origin/revproxy/models', 'POST', { setAll: exposed ? 'on' : 'off' })
      setStatus(exposed ? '全部模型已开放反代' : '全部模型已关闭反代')
      await refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '模型外接范围更新失败')
    } finally {
      setBusy(false)
    }
  }

  async function setExposed(model: ModelRecord, exposed: boolean): Promise<void> {
    const id = String(model.id || '')
    if (!id) return
    setBusy(true)
    setError('')
    try {
      await api.request('/origin/revproxy/models', 'POST', { modelUid: id, exposed })
      setStatus(`${id} 已${exposed ? '开放' : '关闭'}反代`)
      await refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '模型外接范围更新失败')
    } finally {
      setBusy(false)
    }
  }

  async function setTier(family: FamilyRecord, modelUid: string): Promise<void> {
    const familyUid = String(family.uid || family.familyUid || '')
    if (!familyUid || !modelUid) return
    setBusy(true)
    setError('')
    try {
      await api.request('/origin/revproxy/tier', 'POST', { familyUid, modelUid })
      setStatus(`${String(family.label || family.familyLabel || familyUid)} 已切换档位`)
      await refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '档位切换失败')
    } finally {
      setBusy(false)
    }
  }

  async function saveHandoff(): Promise<void> {
    setBusy(true)
    setError('')
    try {
      const content = await api.request<string>('/origin/revproxy/handoff.md')
      const result = await desktopHost().saveHandoff(content, 'fomo-flow-revproxy-handoff.md')
      setStatus(result.ok ? '反代交接文档已保存' : '已取消保存')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '反代交接文档保存失败')
    } finally {
      setBusy(false)
    }
  }

  async function copyHandoff(): Promise<void> {
    setBusy(true)
    setError('')
    try {
      const content = await api.request<string>('/origin/revproxy/handoff.md')
      await desktopHost().writeClipboard(content)
      setStatus('反代交接文档已复制')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '反代交接文档读取失败')
    } finally {
      setBusy(false)
    }
  }

  async function copyEndpoint(endpoint: string, endpointProtocol = protocol): Promise<void> {
    if (!endpoint) return
    try {
      await desktopHost().writeClipboard(endpoint)
      setStatus(`${protocolLabel(endpointProtocol)} 端点已复制`)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '端点复制失败')
    }
  }

  if (loading && models.length === 0 && Object.keys(raw).length === 0)
    return <LoadingState label="正在加载模型反代状态…" />

  return (
    <ControlView
      eyebrow="REVPROXY / 模型反代"
      title="模型反代网关"
      description="单独控制本地 OpenAI、Responses、Anthropic 与 Gemini 端点；模型暴露范围和档位切换均通过受限 IPC 请求。"
      onRefresh={() => void refresh()}
      loading={loading || busy}
    >
      <section className="hero-panel">
        <div>
          <p className="workspace-kicker">LOCAL GATEWAY</p>
          <h2>{draft.enabled ? '反代正在运行' : '反代尚未启用'}</h2>
          <p>{String(raw.endpoint || '启用后生成本机 /v1 端点')}</p>
        </div>
        <span className={`state-pill ${draft.enabled ? 'state-good' : 'state-muted'}`}>
          {draft.enabled ? 'RUNNING' : 'OFF'}
        </span>
      </section>

      <div className="metric-row">
        <article className="metric-card">
          <span>模型目录</span>
          <strong>{formatCount(stats.total || models.length)}</strong>
          <small>
            {formatCount(stats.official)} 官方 · {formatCount(stats.channel)} 渠道
          </small>
        </article>
        <article className="metric-card">
          <span>对外暴露</span>
          <strong>
            {exposedCount}/{models.length}
          </strong>
          <small>{formatCount(stats.disabled)} 个已禁用</small>
        </article>
        <article className="metric-card">
          <span>可用性颜色</span>
          <strong>{formatCount(greenCount)}</strong>
          <small>
            绿 {greenCount} · 黄 {amberCount} · 红 {redCount}
          </small>
        </article>
        <article className="metric-card">
          <span>协议入口</span>
          <strong>{supportedProtocols.length || endpointRows.length}</strong>
          <small>{quotaLabel(raw.premiumQuota)}</small>
        </article>
      </div>

      <ControlPanel title="本地访问入口" note={String(raw.version || '运行时状态')}>
        <div className="control-definition-grid">
          <div>
            <dt>Base URL</dt>
            <dd>
              <code>{String(raw.endpoint || '—')}</code>
            </dd>
          </div>
          <div>
            <dt>API Key</dt>
            <dd>{raw.hasKey ? String(raw.apiKey || '••••••••') : '未生成'}</dd>
          </div>
          <div>
            <dt>局域网访问</dt>
            <dd>{draft.exposeLan ? '已允许' : '仅本机'}</dd>
          </div>
          <div>
            <dt>双路径</dt>
            <dd>{raw.dualPath === true ? '已启用' : '标准路径'}</dd>
          </div>
          <div>
            <dt>默认输出</dt>
            <dd>{formatTokens(draft.defaultMaxTokens)} tok</dd>
          </div>
          <div>
            <dt>密钥状态</dt>
            <dd>{raw.hasKey ? '已生成 · 脱敏显示' : '未生成'}</dd>
          </div>
        </div>
        <div className="control-actions-row">
          <button
            className="control-action control-action-secondary"
            type="button"
            disabled={busy || !raw.endpoint}
            onClick={() => void copyEndpoint(String(raw.endpoint || ''))}
          >
            复制 Base URL
          </button>
          <span className="control-inline-note">
            API Key 仅显示脱敏状态；完整 Key 保留在兼容页的显式操作边界内。
          </span>
        </div>
      </ControlPanel>

      <ControlPanel title="四协议端点" note="只显示本机地址，Key 不写入页面">
        {endpointRows.length === 0 ? (
          <ControlListEmpty label="运行时尚未返回协议端点。" />
        ) : (
          <div className="control-endpoint-list">
            {endpointRows.map((item) => (
              <div key={item.protocol}>
                <span>{protocolLabel(item.protocol)}</span>
                <code>{item.endpoint}</code>
                <button
                  className="control-action control-action-quiet"
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setProtocol(item.protocol)
                    void copyEndpoint(item.endpoint, item.protocol)
                  }}
                >
                  复制
                </button>
              </div>
            ))}
          </div>
        )}
      </ControlPanel>

      <ControlPanel title="网关策略" note="保存后热生效">
        <div className="control-toggle-grid">
          <ControlToggle
            label="启用模型反代"
            checked={draft.enabled}
            onChange={(value) => setDraft({ ...draft, enabled: value })}
            disabled={busy}
          />
          <ControlToggle
            label="入站提示执行本源反观"
            checked={draft.applyInvert}
            onChange={(value) => setDraft({ ...draft, applyInvert: value })}
            disabled={busy}
          />
          <ControlToggle
            label="提示词隔离"
            checked={draft.isolatePrompt}
            onChange={(value) => setDraft({ ...draft, isolatePrompt: value })}
            disabled={busy}
          />
          <ControlToggle
            label="允许局域网访问"
            checked={draft.exposeLan}
            onChange={(value) => setDraft({ ...draft, exposeLan: value })}
            disabled={busy}
          />
        </div>
        <div className="control-form-grid control-form-grid-compact">
          <ControlField label="默认最大输出 Token">
            <input
              type="number"
              min="1"
              value={draft.defaultMaxTokens}
              onChange={(event) => setDraft({ ...draft, defaultMaxTokens: event.target.value })}
            />
          </ControlField>
        </div>
        <div className="control-actions-row">
          <ActionButton busy={busy} variant="primary" onClick={() => void saveConfig(false)}>
            保存网关策略
          </ActionButton>
          <button
            className="control-action control-action-danger"
            type="button"
            disabled={busy}
            onClick={() => void saveConfig(true)}
          >
            保存并重置 API Key
          </button>
        </div>
      </ControlPanel>

      <ControlPanel title="端点交接" note="用户动作才读取完整文档">
        <div className="control-actions-row">
          <button
            className="control-action control-action-secondary"
            type="button"
            disabled={busy}
            onClick={() => void copyHandoff()}
          >
            复制反代交接文档
          </button>
          <button
            className="control-action control-action-quiet"
            type="button"
            disabled={busy}
            onClick={() => void saveHandoff()}
          >
            保存 Markdown
          </button>
        </div>
      </ControlPanel>

      <ControlPanel
        title="对外模型"
        note={`${models.filter((model) => model.exposed !== false).length}/${models.length} 已开放`}
      >
        <div className="control-actions-row">
          <button
            className="control-action control-action-secondary"
            type="button"
            disabled={busy}
            onClick={() => void setAll(true)}
          >
            全部开放
          </button>
          <button
            className="control-action control-action-quiet"
            type="button"
            disabled={busy}
            onClick={() => void setAll(false)}
          >
            全部关闭
          </button>
          <input
            className="control-filter"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="筛选模型 UID / 渠道"
          />
        </div>
        {filteredModels.length === 0 ? (
          <ControlListEmpty label="暂无可反代模型。" />
        ) : (
          <div className="control-record-list revproxy-model-list">
            {filteredModels.map((model) => {
              const id = String(model.id || '')
              const tone = modelTone(model)
              const badges = capabilityBadges(model.capabilities)
              const route = asRecord(model.dao_route)
              const channels = asArray(model.channelPriority).map((item) => asRecord(item))
              return (
                <article className="control-record-row" key={id}>
                  <div className="control-record-main">
                    <span
                      className={`health-dot health-${tone === 'good' ? 'up' : tone === 'bad' ? 'down' : 'idle'}`}
                      aria-hidden="true"
                    />
                    <div>
                      <strong>
                        {id}{' '}
                        <ControlBadge tone={tone}>
                          {model.exposed === false ? '未开放' : String(model.status || '可用')}
                        </ControlBadge>{' '}
                        {model.free === true && <ControlBadge tone="good">免费</ControlBadge>}{' '}
                        {model.custom === true && (
                          <ControlBadge tone="brand">⑦ 自定义</ControlBadge>
                        )}{' '}
                        {model.dao_bridge === true && (
                          <ControlBadge tone="brand">⑥ 中转</ControlBadge>
                        )}
                      </strong>
                      <small>
                        {String(model.provider || model.owned_by || '自动路由')} ·{' '}
                        {String(model.model || model.note || '')}
                      </small>
                      <small>
                        {route.provider || route.model
                          ? `实际路由 ${String(route.provider || '—')} / ${String(route.model || '—')}`
                          : String(model.reverse === 'official' ? '官方直通' : '等待路由')}{' '}
                        · {String(model.tier || 'base')}
                      </small>
                      {channels.length > 0 && (
                        <small>
                          渠道队列{' '}
                          {channels
                            .slice(0, 3)
                            .map(
                              (channel, index) =>
                                `${index === 0 ? '首选' : `备用${index}`} ${String(channel.provider || '')}/${String(channel.model || '')}`
                            )
                            .join(' · ')}
                          {channels.length > 3 ? ` · +${channels.length - 3}` : ''}
                        </small>
                      )}
                      {badges.length > 0 && (
                        <span className="control-badge-row">
                          {badges.map((badge) => (
                            <ControlBadge key={badge} tone="muted">
                              {badge}
                            </ControlBadge>
                          ))}
                        </span>
                      )}
                    </div>
                  </div>
                  <ControlToggle
                    label={model.exposed === false ? '未开放' : '已开放'}
                    checked={model.exposed !== false}
                    onChange={(value) => void setExposed(model, value)}
                    disabled={busy}
                  />
                </article>
              )
            })}
          </div>
        )}
      </ControlPanel>

      <ControlPanel title="家族档位" note="按家族热切换">
        {families.length === 0 ? (
          <ControlListEmpty label="当前没有多档模型家族。" />
        ) : (
          <div className="control-record-list revproxy-family-list">
            {families.map((family, index) => {
              const familyUid = String(family.uid || family.familyUid || `family-${index}`)
              const members = asArray(family.members)
                .map((item) => asRecord(item))
                .filter((item) => item.id || item.modelUid)
              const current = String(
                tiers[familyUid] || members[0]?.id || members[0]?.modelUid || ''
              )
              return (
                <article className="control-record-row" key={familyUid}>
                  <div className="control-record-main">
                    <div>
                      <strong>
                        {String(family.label || family.familyLabel || familyUid)}{' '}
                        {family.multi === true && <ControlBadge tone="brand">多档</ControlBadge>}
                      </strong>
                      <small>
                        {familyUid} · {members.length} 档
                      </small>
                      <small>
                        当前 {String(family.activeUid || current || '—')} ·{' '}
                        {String(family.provider || '自动路由')}
                      </small>
                    </div>
                  </div>
                  <select
                    aria-label={`${familyUid} 当前档位`}
                    value={current}
                    disabled={busy}
                    onChange={(event) => void setTier(family, event.target.value)}
                  >
                    {members.map((member) => (
                      <option
                        key={String(member.id || member.modelUid)}
                        value={String(member.id || member.modelUid)}
                      >
                        {String(member.label || member.id || member.modelUid)}
                      </option>
                    ))}
                  </select>
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
