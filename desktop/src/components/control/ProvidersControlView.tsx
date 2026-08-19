import { useEffect, useMemo, useState } from 'react'

import { asArray, asRecord } from '@/lib/daoControlApi'
import { desktopHost } from '@/lib/desktopHost'

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
  cacheLine,
  capabilityBadges,
  formatCount,
  formatTokens,
  healthState,
  protocolLabel,
  usageLine
} from './controlDisplay'
import { ChannelMigrationCard } from './ChannelMigrationCard'

type ProviderRecord = Record<string, unknown> & {
  name?: string
  _label?: string
  baseUrl?: string
  protocol?: string
  models?: unknown[]
  _models?: unknown[]
  _builtin?: boolean
  apiKey?: string
  enabled?: boolean
  health?: unknown
  usage?: unknown
  supportedProtocols?: unknown[]
  modelCapabilities?: unknown
  _bridgeManaged?: boolean
  _codexManaged?: boolean
}

type ProviderDraft = {
  name: string
  baseUrl: string
  apiKey: string
  protocol: string
  models: string
}

const emptyDraft: ProviderDraft = { name: '', baseUrl: '', apiKey: '', protocol: '', models: '' }

function providerRows(value: unknown, overview: Record<string, unknown> = {}): ProviderRecord[] {
  const record = asRecord(value)
  const source = asRecord(record.providers)
  const overviewProviders = asRecord(overview.providers)
  const health = asRecord(overview.health)
  const usage = asRecord(overview.usage)
  return Object.entries(source)
    .map(([name, item]) => {
      const row = asRecord(item)
      const overviewRow = asRecord(overviewProviders[name])
      return {
        name,
        ...overviewRow,
        ...row,
        health: row.health || overviewRow.health || health[name],
        usage: row.usage || overviewRow.usage || usage[name]
      } as ProviderRecord
    })
    .sort((a, b) => String(a._label || a.name).localeCompare(String(b._label || b.name)))
}

function modelNames(provider: ProviderRecord): string[] {
  const source = Array.isArray(provider.models) ? provider.models : provider._models
  return asArray(source)
    .map((item) => {
      if (typeof item === 'string') return item
      const row = asRecord(item)
      return String(row.id || row.name || row.model || '')
    })
    .filter(Boolean)
}

function customModelRows(value: unknown): Array<Record<string, unknown>> {
  const source = asRecord(value)
  if (Array.isArray(source.custom_models)) return source.custom_models.map(asRecord)
  return Object.entries(asRecord(source.custom_models)).map(([id, item]) => ({
    id,
    ...asRecord(item)
  }))
}

function customModelCount(value: unknown, providerName: string): number {
  return customModelRows(value).filter((model) => {
    if (String(model.provider || '') === providerName) return true
    return asArray(model.channels).some(
      (channel) => String(asRecord(channel).provider || '') === providerName
    )
  }).length
}

export function ProvidersControlView() {
  const api = useDaoApi()
  const [providers, setProviders] = useState<ProviderRecord[]>([])
  const [overview, setOverview] = useState<Record<string, unknown>>({})
  const [usage, setUsage] = useState<Record<string, unknown>>({})
  const [draft, setDraft] = useState<ProviderDraft>(emptyDraft)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')
  const [handoff, setHandoff] = useState('')

  async function refresh(): Promise<void> {
    setLoading(true)
    setError('')
    try {
      const [providerRaw, overviewRaw, usageRaw] = await Promise.all([
        api.request('/origin/ea/providers'),
        api.request('/origin/ea/overview'),
        api.request('/origin/ea/usage')
      ])
      const nextOverview = {
        ...asRecord(overviewRaw),
        usage: asRecord(usageRaw).usage || asRecord(overviewRaw).usage
      }
      setOverview(nextOverview)
      setUsage(asRecord(usageRaw))
      setProviders(providerRows(providerRaw, nextOverview))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '渠道目录读取失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void refresh()
  }, [])

  const enabledCount = useMemo(
    () => providers.filter((item) => item._builtin !== true && item.enabled !== false).length,
    [providers]
  )
  const customCount = customModelRows(overview).length
  const routeCount = Object.keys(asRecord(overview.routes)).length
  const routerReady = overview.router_ready === true
  const healthyCount = providers.filter(
    (provider) => healthState(provider.health, provider._builtin === true).tone === 'good'
  ).length
  const totalModelCount = providers.reduce((sum, provider) => sum + modelNames(provider).length, 0)
  const totalUsage = asRecord(usage.totals)

  function editProvider(provider: ProviderRecord): void {
    setDraft({
      name: String(provider.name || ''),
      baseUrl: String(provider.baseUrl || ''),
      apiKey: '',
      protocol: String(provider.protocol || ''),
      models: modelNames(provider).join(', ')
    })
    setStatus(`正在编辑 ${String(provider._label || provider.name || '')}`)
  }

  async function saveProvider(): Promise<void> {
    if (!draft.name.trim() || !draft.baseUrl.trim()) {
      setError('渠道名称和 Base URL 必填')
      return
    }
    setBusy(true)
    setError('')
    setStatus('保存渠道并刷新模型目录…')
    try {
      const cfg: Record<string, unknown> = {
        baseUrl: draft.baseUrl.trim(),
        protocol: draft.protocol || undefined
      }
      if (draft.apiKey.trim()) cfg.apiKey = draft.apiKey.trim()
      if (draft.models.trim()) {
        cfg.models = draft.models
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean)
      }
      await api.request('/origin/ea/provider', 'POST', { name: draft.name.trim(), cfg })
      await api.request(`/origin/ea/models/${encodeURIComponent(draft.name.trim())}?refresh=1`)
      setDraft(emptyDraft)
      setStatus(`渠道 ${draft.name.trim()} 已保存`)
      await refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '渠道保存失败')
    } finally {
      setBusy(false)
    }
  }

  async function probe(): Promise<void> {
    setBusy(true)
    setError('')
    try {
      const result = asRecord(await api.request('/origin/ea/probe', 'POST', {}))
      setStatus(`已完成 ${Object.keys(asRecord(result.providers)).length} 个渠道探活`)
      await refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '渠道探活失败')
    } finally {
      setBusy(false)
    }
  }

  async function refreshModels(provider: ProviderRecord): Promise<void> {
    const name = String(provider.name || '')
    if (!name) return
    setBusy(true)
    setError('')
    try {
      const result = asRecord(
        await api.request(`/origin/ea/models/${encodeURIComponent(name)}?refresh=1`)
      )
      setStatus(`${name} 已刷新 ${asArray(result.models).length} 个模型`)
      await refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '模型目录刷新失败')
    } finally {
      setBusy(false)
    }
  }

  async function removeProvider(provider: ProviderRecord): Promise<void> {
    const name = String(provider.name || '')
    if (!name || provider._builtin === true) return
    setBusy(true)
    setError('')
    try {
      await api.request(`/origin/ea/provider/${encodeURIComponent(name)}`, 'DELETE')
      setStatus(`渠道 ${name} 已删除，关联路由由运行时处理`)
      await refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '渠道删除失败')
    } finally {
      setBusy(false)
    }
  }

  async function loadHandoff(): Promise<string> {
    const content = await api.request<string>('/origin/ea/handoff.md')
    setHandoff(content)
    return content
  }

  async function copyHandoff(): Promise<void> {
    setBusy(true)
    setError('')
    try {
      await desktopHost().writeClipboard(await loadHandoff())
      setStatus('最新渠道/路由交接文档已复制')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '交接文档读取失败')
    } finally {
      setBusy(false)
    }
  }

  async function saveHandoff(): Promise<void> {
    setBusy(true)
    setError('')
    try {
      const result = await desktopHost().saveHandoff(
        await loadHandoff(),
        'dao-flow-provider-handoff.md'
      )
      setStatus(result.ok ? '渠道交接文档已保存' : '已取消保存')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '交接文档保存失败')
    } finally {
      setBusy(false)
    }
  }

  if (loading && providers.length === 0) return <LoadingState label="正在加载渠道与模型目录…" />

  return (
    <ControlView
      eyebrow="PROVIDERS / 渠道"
      title="渠道与模型目录"
      description="逐个管理上游渠道、探测模型并保留脱敏边界。API Key 只在主进程和运行时之间流转，React 只显示配置状态。"
      onRefresh={() => void refresh()}
      loading={loading || busy}
    >
      <div className="metric-row">
        <article className="metric-card">
          <span>渠道总数</span>
          <strong>{providers.length}</strong>
          <small>{enabledCount} 个已启用外接渠道</small>
        </article>
        <article className="metric-card">
          <span>模型总数</span>
          <strong>{totalModelCount}</strong>
          <small>当前缓存目录</small>
        </article>
        <article className="metric-card">
          <span>渠道健康</span>
          <strong>
            {healthyCount}/{providers.length}
          </strong>
          <small>绿点来自最近一次探活</small>
        </article>
        <article className="metric-card">
          <span>路由器</span>
          <strong>{routerReady ? 'READY' : '待命'}</strong>
          <small>
            {routeCount} 条路由 · {customCount} 个自定义模型
          </small>
        </article>
      </div>

      <ControlPanel title="运行态快照" note="与渠道 / 路由 / 反代面板同源">
        <ControlReadoutGrid>
          <ControlReadout
            label="路由器状态"
            value={routerReady ? 'READY' : 'STANDBY'}
            detail={routeCount ? `${formatCount(routeCount)} 条活动配置` : '尚无路由配置'}
            tone={routerReady ? 'good' : 'warn'}
          />
          <ControlReadout
            label="自定义模型"
            value={formatCount(customCount)}
            detail="已同步到路由与反代目录"
            tone={customCount ? 'brand' : 'muted'}
          />
          <ControlReadout
            label="全局请求"
            value={formatCount(totalUsage.calls)}
            detail={`${formatTokens(totalUsage.total)} tok · 内存态聚合`}
          />
          <ControlReadout label="密钥边界" value="脱敏" detail="留空保存会保留原 Key" tone="good" />
        </ControlReadoutGrid>
      </ControlPanel>

      <ChannelMigrationCard onMigrated={refresh} />

      <ControlPanel title="添加或更新渠道" note="热更新">
        <div className="control-form-grid">
          <ControlField label="渠道名">
            <input
              value={draft.name}
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              placeholder="例如 openrouter"
            />
          </ControlField>
          <ControlField label="Base URL">
            <input
              value={draft.baseUrl}
              onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })}
              placeholder="https://api.example.com/v1"
            />
          </ControlField>
          <ControlField label="API Key（可选）">
            <input
              type="password"
              value={draft.apiKey}
              onChange={(event) => setDraft({ ...draft, apiKey: event.target.value })}
              placeholder="留空保留已配置 Key"
              autoComplete="off"
            />
          </ControlField>
          <ControlField label="默认协议">
            <select
              value={draft.protocol}
              onChange={(event) => setDraft({ ...draft, protocol: event.target.value })}
            >
              <option value="">跟随渠道</option>
              <option value="openai-chat">OpenAI Chat</option>
              <option value="openai-responses">OpenAI Responses</option>
              <option value="anthropic">Anthropic</option>
              <option value="gemini">Gemini</option>
            </select>
          </ControlField>
          <ControlField label="模型（逗号分隔）" wide>
            <input
              value={draft.models}
              onChange={(event) => setDraft({ ...draft, models: event.target.value })}
              placeholder="留空则保存后自动探测"
            />
          </ControlField>
        </div>
        <div className="control-actions-row">
          <ActionButton busy={busy} variant="primary" onClick={() => void saveProvider()}>
            保存渠道
          </ActionButton>
          <button
            className="control-action control-action-quiet"
            type="button"
            onClick={() => {
              setDraft(emptyDraft)
              setStatus('已清空编辑器')
            }}
          >
            新建
          </button>
          <ActionButton busy={busy} onClick={() => void probe()}>
            全部探活
          </ActionButton>
        </div>
      </ControlPanel>

      <ControlPanel title="已配置渠道" note={`${providers.length} 个`}>
        {providers.length === 0 ? (
          <ControlListEmpty label="还没有渠道，先在上方添加一个。" />
        ) : (
          <div className="control-record-list provider-record-list">
            {providers.map((provider) => {
              const name = String(provider.name || '')
              const models = modelNames(provider)
              const builtin = provider._builtin === true
              const health = healthState(provider.health, builtin)
              const protocols = asArray(provider.supportedProtocols)
                .map(protocolLabel)
                .filter(Boolean)
              const capabilityCount = Object.keys(asRecord(provider.modelCapabilities)).length
              const customModels = customModelCount(overview, name)
              const badges = capabilityBadges({ capabilities: provider.modelCapabilities })
              return (
                <article className="control-record-row" key={name}>
                  <div className="control-record-main">
                    <span
                      className={`health-dot ${
                        health.tone === 'good'
                          ? 'health-up'
                          : health.tone === 'bad'
                            ? 'health-down'
                            : 'health-idle'
                      }`}
                      aria-hidden="true"
                    />
                    <div>
                      <strong>
                        {String(provider._label || name)}{' '}
                        <ControlBadge tone={health.tone}>{health.label}</ControlBadge>{' '}
                        {provider.enabled === false && (
                          <ControlBadge tone="bad">已停用</ControlBadge>
                        )}
                        {builtin && <ControlBadge tone="brand">内置</ControlBadge>}
                        {provider._bridgeManaged && (
                          <ControlBadge tone="brand">协议中转</ControlBadge>
                        )}
                        {provider._codexManaged && <ControlBadge tone="brand">Codex</ControlBadge>}
                      </strong>
                      <small>
                        {name} · {String(provider.baseUrl || '未配置 URL')}
                      </small>
                      <small>
                        {models.length
                          ? `${models.length} 个模型 · ${models.slice(0, 5).join(', ')}`
                          : '尚未探测模型'}
                      </small>
                      <small>
                        {protocols.length ? protocols.join(' · ') : '自动协议'} · 能力元数据{' '}
                        {capabilityCount || 0} 条
                      </small>
                      <small>
                        {usageLine(provider)} · {cacheLine(provider)}
                      </small>
                      {customModels > 0 && (
                        <small>⑦ 自定义模型 {customModels} 个 · 已同步③④⑥</small>
                      )}
                      {badges.length > 0 && (
                        <span className="control-badge-row">
                          {badges.slice(0, 3).map((badge) => (
                            <ControlBadge key={badge} tone="muted">
                              {badge}
                            </ControlBadge>
                          ))}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="control-record-actions">
                    <button
                      className="control-action control-action-quiet"
                      type="button"
                      disabled={busy}
                      onClick={() => void refreshModels(provider)}
                    >
                      刷新模型
                    </button>
                    {!builtin && (
                      <button
                        className="control-action control-action-quiet"
                        type="button"
                        disabled={busy}
                        onClick={() => editProvider(provider)}
                      >
                        编辑
                      </button>
                    )}
                    {!builtin && (
                      <button
                        className="control-action control-action-danger"
                        type="button"
                        disabled={busy}
                        onClick={() => void removeProvider(provider)}
                      >
                        删除
                      </button>
                    )}
                  </div>
                </article>
              )
            })}
          </div>
        )}
      </ControlPanel>
      <ControlPanel title="交接与审阅" note="实时反映渠道、路由与自定义模型">
        <div className="control-actions-row">
          <button
            className="control-action control-action-secondary"
            type="button"
            disabled={busy}
            onClick={() => void copyHandoff()}
          >
            复制最新状态
          </button>
          <button
            className="control-action control-action-quiet"
            type="button"
            disabled={busy}
            onClick={() => void saveHandoff()}
          >
            保存 Markdown
          </button>
          <button
            className="control-action control-action-quiet"
            type="button"
            disabled={busy}
            onClick={() => void loadHandoff()}
          >
            预览
          </button>
        </div>
        {handoff && <pre className="control-preview">{handoff}</pre>}
      </ControlPanel>
      <ControlStatus message={error || status} error={Boolean(error)} />
    </ControlView>
  )
}
