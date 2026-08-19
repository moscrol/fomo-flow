import { useEffect, useState } from 'react'

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
import { ControlBadge, ControlReadout, ControlReadoutGrid } from './ControlReadout'
import { formatCount, formatTokens, protocolLabel } from './controlDisplay'

const protocols = [
  ['openai-chat', 'OpenAI Chat'],
  ['openai-responses', 'OpenAI Responses'],
  ['anthropic', 'Anthropic'],
  ['gemini', 'Gemini']
] as const

type BridgeProfile = Record<string, unknown> & {
  id?: string
  name?: string
  targetProtocols?: unknown[]
}

type BridgeDraft = {
  id: string
  name: string
  providerMode: string
  providerName: string
  sourceRouteUid: string
  sourceModel: string
  sourceProtocol: string
  baseUrl: string
  apiKey: string
  outputModel: string
  maxOutputTokens: string
  reasoningLevel: string
  targetProtocols: string[]
}

const emptyDraft: BridgeDraft = {
  id: '',
  name: '',
  providerMode: 'existing',
  providerName: '',
  sourceRouteUid: '',
  sourceModel: '',
  sourceProtocol: 'openai-chat',
  baseUrl: '',
  apiKey: '',
  outputModel: '',
  maxOutputTokens: '16384',
  reasoningLevel: 'off',
  targetProtocols: ['openai-responses']
}

function profileRows(value: unknown): BridgeProfile[] {
  return asArray(asRecord(value).profiles).map((item) => asRecord(item) as BridgeProfile)
}

function providerNames(value: unknown): string[] {
  const providers = asArray(asRecord(value).providers)
  return providers.map((item) => String(asRecord(item).name || '')).filter(Boolean)
}

export function BridgesControlView() {
  const api = useDaoApi()
  const [profiles, setProfiles] = useState<BridgeProfile[]>([])
  const [providers, setProviders] = useState<string[]>([])
  const [availableProtocols, setAvailableProtocols] = useState<string[]>([])
  const [draft, setDraft] = useState<BridgeDraft>(emptyDraft)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')

  async function refresh(): Promise<void> {
    setLoading(true)
    setError('')
    try {
      const data = asRecord(await api.request('/origin/protocol-bridges'))
      setProfiles(profileRows(data))
      setProviders(providerNames(data))
      setAvailableProtocols(asArray(data.protocols).map(String))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '协议桥读取失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void refresh()
  }, [])

  function edit(profile: BridgeProfile): void {
    setDraft({
      id: String(profile.id || ''),
      name: String(profile.name || ''),
      providerMode: String(profile.providerMode || 'existing'),
      providerName: String(profile.providerName || ''),
      sourceRouteUid: String(profile.sourceRouteUid || ''),
      sourceModel: String(profile.sourceModel || ''),
      sourceProtocol: String(profile.sourceProtocol || 'openai-chat'),
      baseUrl: String(profile.baseUrl || ''),
      apiKey: '',
      outputModel: String(profile.outputModel || ''),
      maxOutputTokens: String(profile.maxOutputTokens || '16384'),
      reasoningLevel: String(profile.reasoningLevel || 'off'),
      targetProtocols: asArray(profile.targetProtocols).filter(
        (item): item is string => typeof item === 'string'
      )
    })
    setStatus(`正在编辑 ${String(profile.name || profile.id || '')}`)
  }

  function setProtocol(protocol: string, checked: boolean): void {
    setDraft((current) => ({
      ...current,
      targetProtocols: checked
        ? Array.from(new Set([...current.targetProtocols, protocol]))
        : current.targetProtocols.filter((item) => item !== protocol)
    }))
  }

  async function save(): Promise<void> {
    if (!draft.name.trim() || !draft.outputModel.trim()) {
      setError('档案名称和对外模型必填')
      return
    }
    if (!draft.targetProtocols.length) {
      setError('至少选择一个对外协议')
      return
    }
    setBusy(true)
    setError('')
    try {
      const body: Record<string, unknown> = {
        id: draft.id || undefined,
        name: draft.name.trim(),
        providerMode: draft.providerMode,
        providerName: draft.providerName.trim(),
        sourceRouteUid: draft.sourceRouteUid.trim() || undefined,
        sourceModel: draft.sourceModel.trim(),
        sourceProtocol: draft.sourceProtocol,
        baseUrl: draft.baseUrl.trim(),
        outputModel: draft.outputModel.trim(),
        targetProtocols: draft.targetProtocols,
        maxOutputTokens: Number(draft.maxOutputTokens) || 16384,
        reasoningLevel: draft.reasoningLevel
      }
      if (draft.apiKey.trim()) body.apiKey = draft.apiKey.trim()
      const result = asRecord(await api.request('/origin/protocol-bridges', 'POST', body))
      setStatus(`协议桥已保存：${String(asRecord(result.profile).name || draft.name)}`)
      setDraft(emptyDraft)
      await refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '协议桥保存失败')
    } finally {
      setBusy(false)
    }
  }

  async function remove(profile: BridgeProfile): Promise<void> {
    const id = String(profile.id || '')
    if (!id) return
    setBusy(true)
    setError('')
    try {
      await api.request(`/origin/protocol-bridges/${encodeURIComponent(id)}`, 'DELETE')
      setStatus(`协议桥 ${id} 已删除`)
      await refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '协议桥删除失败')
    } finally {
      setBusy(false)
    }
  }

  async function copyEndpoints(profile: BridgeProfile): Promise<void> {
    const endpoints = asRecord(profile.endpoints)
    const text = Object.entries(endpoints)
      .map(([protocol, endpoint]) => `${protocol}: ${String(endpoint)}`)
      .join('\n')
    await desktopHost().writeClipboard(text || String(profile.outputModel || ''))
    setStatus('协议桥端点已复制')
  }

  if (loading && profiles.length === 0) return <LoadingState label="正在加载协议桥档案…" />

  const endpointCount = profiles.reduce(
    (sum, profile) => sum + Object.keys(asRecord(profile.endpoints)).length,
    0
  )
  const managedCount = profiles.filter(
    (profile) => profile.managed === true || profile.providerMode === 'managed'
  ).length
  const multiProtocolCount = profiles.filter(
    (profile) => asArray(profile.targetProtocols).length > 1
  ).length

  return (
    <ControlView
      eyebrow="BRIDGES / 协议桥"
      title="协议转换桥"
      description="每个桥档案独立描述来源渠道、输入协议和对外协议，适合把 Chat、Responses、Anthropic 与 Gemini 能力逐项挂接。"
      onRefresh={() => void refresh()}
      loading={loading || busy}
    >
      <ControlPanel title="协议桥运行态" note="组件级端点投影">
        <ControlReadoutGrid>
          <ControlReadout
            label="桥档案"
            value={formatCount(profiles.length)}
            detail={`${formatCount(managedCount)} 个托管来源`}
            tone={profiles.length ? 'brand' : 'muted'}
          />
          <ControlReadout
            label="对外端点"
            value={formatCount(endpointCount)}
            detail={`${formatCount(multiProtocolCount)} 个档案支持多协议`}
          />
          <ControlReadout
            label="可用协议"
            value={formatCount(availableProtocols.length)}
            detail={availableProtocols.map(protocolLabel).join(' · ') || '运行时未返回'}
          />
          <ControlReadout
            label="来源渠道"
            value={formatCount(providers.length)}
            detail="来自协议桥运行时目录"
          />
        </ControlReadoutGrid>
      </ControlPanel>
      <ControlPanel title="创建或编辑协议桥" note="写入前端点校验">
        <div className="control-form-grid">
          <ControlField label="档案名称">
            <input
              value={draft.name}
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              placeholder="例如 claude-to-responses"
            />
          </ControlField>
          <ControlField label="来源模式">
            <select
              value={draft.providerMode}
              onChange={(event) => setDraft({ ...draft, providerMode: event.target.value })}
            >
              <option value="existing">已有渠道</option>
              <option value="custom">自定义路由</option>
              <option value="managed">托管新渠道</option>
            </select>
          </ControlField>
          <ControlField label="来源渠道">
            <select
              value={draft.providerName}
              onChange={(event) => setDraft({ ...draft, providerName: event.target.value })}
            >
              <option value="">选择渠道</option>
              {providers.map((provider) => (
                <option key={provider} value={provider}>
                  {provider}
                </option>
              ))}
            </select>
          </ControlField>
          <ControlField label="来源模型">
            <input
              value={draft.sourceModel}
              onChange={(event) => setDraft({ ...draft, sourceModel: event.target.value })}
              placeholder="真实上游模型名"
            />
          </ControlField>
          <ControlField label="来源协议">
            <select
              value={draft.sourceProtocol}
              onChange={(event) => setDraft({ ...draft, sourceProtocol: event.target.value })}
            >
              {protocols.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </ControlField>
          <ControlField label="对外模型 UID">
            <input
              value={draft.outputModel}
              onChange={(event) => setDraft({ ...draft, outputModel: event.target.value })}
              placeholder="对外统一模型名"
            />
          </ControlField>
          <ControlField label="托管 Base URL">
            <input
              value={draft.baseUrl}
              onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })}
              placeholder="仅托管模式填写"
            />
          </ControlField>
          <ControlField label="托管 API Key">
            <input
              type="password"
              value={draft.apiKey}
              onChange={(event) => setDraft({ ...draft, apiKey: event.target.value })}
              placeholder="留空保留原值"
              autoComplete="off"
            />
          </ControlField>
          <ControlField label="最大输出 Token">
            <input
              type="number"
              min="1"
              value={draft.maxOutputTokens}
              onChange={(event) => setDraft({ ...draft, maxOutputTokens: event.target.value })}
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
        </div>
        <div className="control-fieldset">
          <span className="control-fieldset-label">对外协议</span>
          <div className="control-toggle-grid">
            {protocols.map(([value, label]) => (
              <ControlToggle
                key={value}
                label={label}
                checked={draft.targetProtocols.includes(value)}
                onChange={(checked) => setProtocol(value, checked)}
                disabled={busy}
              />
            ))}
          </div>
        </div>
        <div className="control-actions-row">
          <ActionButton busy={busy} variant="primary" onClick={() => void save()}>
            保存协议桥
          </ActionButton>
          <button
            className="control-action control-action-quiet"
            type="button"
            onClick={() => {
              setDraft(emptyDraft)
              setStatus('已清空桥档案编辑器')
            }}
          >
            新建
          </button>
        </div>
      </ControlPanel>

      <ControlPanel title="桥档案" note={`${profiles.length} 个`}>
        {profiles.length === 0 ? (
          <ControlListEmpty label="还没有协议桥档案。" />
        ) : (
          <div className="control-record-list">
            {profiles.map((profile) => {
              const id = String(profile.id || '')
              const targets = asArray(profile.targetProtocols).map(String).join(' + ')
              return (
                <article className="control-record-row" key={id}>
                  <div className="control-record-main">
                    <div>
                      <strong>{String(profile.name || id)}</strong>
                      <span className="control-badge-row">
                        {profile.managed === true || profile.providerMode === 'managed' ? (
                          <ControlBadge tone="brand">托管</ControlBadge>
                        ) : (
                          <ControlBadge tone="muted">已有渠道</ControlBadge>
                        )}
                        {profile.hasKey === true && (
                          <ControlBadge tone="good">Key 已配置</ControlBadge>
                        )}
                        {profile.enabled === false && (
                          <ControlBadge tone="bad">已停用</ControlBadge>
                        )}
                      </span>
                      <small>
                        {String(profile.providerName || profile.sourceRouteUid || '自定义来源')} /{' '}
                        {String(profile.sourceModel || '—')} · {String(profile.outputModel || '—')}
                      </small>
                      <small>
                        来源 {protocolLabel(profile.sourceProtocol)} → {targets || '未选择'} ·{' '}
                        最大输出 {formatTokens(profile.maxOutputTokens)}
                      </small>
                      {Object.keys(asRecord(profile.endpoints)).length > 0 && (
                        <small>
                          端点{' '}
                          {Object.entries(asRecord(profile.endpoints))
                            .map(
                              ([protocol, endpoint]) =>
                                `${protocolLabel(protocol)} ${String(endpoint)}`
                            )
                            .join(' · ')}
                        </small>
                      )}
                    </div>
                  </div>
                  <div className="control-record-actions">
                    <button
                      className="control-action control-action-quiet"
                      type="button"
                      disabled={busy}
                      onClick={() => void copyEndpoints(profile)}
                    >
                      复制端点
                    </button>
                    <button
                      className="control-action control-action-quiet"
                      type="button"
                      disabled={busy}
                      onClick={() => edit(profile)}
                    >
                      编辑
                    </button>
                    <button
                      className="control-action control-action-danger"
                      type="button"
                      disabled={busy}
                      onClick={() => void remove(profile)}
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
