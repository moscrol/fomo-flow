import { useEffect, useState } from 'react'

import { asArray, asRecord } from '@/lib/daoControlApi'

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
import {
  capabilityBadges,
  formatCount,
  formatDate,
  formatTokens,
  protocolLabel
} from './controlDisplay'

type CustomModel = Record<string, unknown> & { id?: string; label?: string; channels?: unknown[] }

type ModelDraft = {
  id: string
  label: string
  provider: string
  upstreamModel: string
  protocol: string
  reasoningLevel: string
  strategy: string
  contextTokens: string
  maxOutputTokens: string
  supportsImages: boolean
  channelsJson: string
}

const emptyDraft: ModelDraft = {
  id: '',
  label: '',
  provider: '',
  upstreamModel: '',
  protocol: '',
  reasoningLevel: 'off',
  strategy: 'priority',
  contextTokens: '131072',
  maxOutputTokens: '16384',
  supportsImages: false,
  channelsJson: ''
}

function providersOf(value: unknown): Array<{ name: string; models: string[] }> {
  const source = asRecord(asRecord(value).providers)
  return Object.entries(source).map(([name, raw]) => {
    const provider = asRecord(raw)
    const models = asArray(Array.isArray(provider.models) ? provider.models : provider._models)
      .map((item) =>
        typeof item === 'string' ? item : String(asRecord(item).id || asRecord(item).model || '')
      )
      .filter(Boolean)
    return { name, models }
  })
}

function runtimeOf(model: CustomModel): Record<string, unknown> {
  return asRecord(model.runtime)
}

const safeProtocols = new Set(['openai-chat', 'openai-responses', 'anthropic', 'gemini'])

function safeProtocol(value: unknown): string {
  const protocol = String(value || '')
  return safeProtocols.has(protocol) ? protocol : ''
}

function protocolAdjustment(runtime: Record<string, unknown>): {
  actual: string
  configured: string
  message: string
} | null {
  const actual = safeProtocol(runtime.actualProtocol)
  const configured = safeProtocol(runtime.configuredProtocol)
  if (
    runtime.protocolAdjusted !== true ||
    runtime.protocolReason !== 'configured-protocol-unsupported' ||
    !actual ||
    !configured ||
    actual === configured
  ) {
    return null
  }
  return {
    actual,
    configured,
    message: '渠道不支持配置协议，已按渠道能力发送'
  }
}

function modelOf(channel: Record<string, unknown>): string {
  return String(channel.upstreamModel || channel.model || '')
}

function parseDraftChannels(draft: ModelDraft): {
  channels: Array<Record<string, unknown>>
  error: string
} {
  if (draft.channelsJson.trim()) {
    try {
      const parsed: unknown = JSON.parse(draft.channelsJson)
      if (!Array.isArray(parsed)) return { channels: [], error: '备用渠道 JSON 必须是数组' }
      return { channels: parsed.map((item) => asRecord(item)), error: '' }
    } catch (cause) {
      return {
        channels: [],
        error: cause instanceof Error ? cause.message : '备用渠道 JSON 无效'
      }
    }
  }
  if (!draft.provider.trim() && !draft.upstreamModel.trim()) return { channels: [], error: '' }
  return {
    channels: [
      {
        provider: draft.provider.trim(),
        upstreamModel: draft.upstreamModel.trim(),
        protocol: draft.protocol,
        reasoningLevel: draft.reasoningLevel
      }
    ],
    error: ''
  }
}

function runtimeLabel(model: CustomModel): {
  label: string
  tone: 'good' | 'warn' | 'bad' | 'muted'
} {
  const runtime = runtimeOf(model)
  if (runtime.state === 'active') return { label: '当前实际使用', tone: 'good' }
  if (runtime.state === 'failed') return { label: '全部渠道失败', tone: 'bad' }
  if (runtime.state === 'degraded') return { label: '降级运行', tone: 'warn' }
  return { label: '尚无运行记录', tone: 'muted' }
}

export function CustomModelsControlView() {
  const api = useDaoApi()
  const [models, setModels] = useState<CustomModel[]>([])
  const [providers, setProviders] = useState<Array<{ name: string; models: string[] }>>([])
  const [draft, setDraft] = useState<ModelDraft>(emptyDraft)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')

  async function refresh(): Promise<void> {
    setLoading(true)
    setError('')
    try {
      const [modelRaw, providerRaw] = await Promise.all([
        api.request('/origin/ea/custom-models'),
        api.request('/origin/ea/providers')
      ])
      setModels(asArray(asRecord(modelRaw).models).map((item) => asRecord(item) as CustomModel))
      setProviders(providersOf(providerRaw))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '自定义模型读取失败')
    } finally {
      setLoading(false)
    }
  }

  async function refreshRuntime(): Promise<void> {
    try {
      const result = asRecord(await api.request('/origin/ea/custom-models'))
      const incoming = asArray(result.models).map((item) => asRecord(item) as CustomModel)
      const byId = new Map(incoming.map((model) => [String(model.id || ''), model]))
      setModels((current) =>
        current.map((model) => {
          const next = byId.get(String(model.id || ''))
          return next
            ? { ...model, runtime: next.runtime || null, channels: next.channels || model.channels }
            : model
        })
      )
    } catch {
      // Runtime polling is opportunistic; the last known configuration stays visible.
    }
  }

  useEffect(() => {
    void refresh()
    const timer = window.setInterval(() => void refreshRuntime(), 5_000)
    return () => window.clearInterval(timer)
  }, [])

  function edit(model: CustomModel): void {
    const channels = asArray(model.channels)
    const first = asRecord(channels[0] || model)
    setDraft({
      id: String(model.id || ''),
      label: String(model.label || model.id || ''),
      provider: String(first.provider || model.provider || ''),
      upstreamModel: String(first.upstreamModel || first.model || model.model || ''),
      protocol: String(first.protocol || model.protocol || ''),
      reasoningLevel: String(first.reasoningLevel || model.reasoningLevel || 'off'),
      strategy: String(model.channelStrategy || 'priority'),
      contextTokens: String(model.contextTokens || '131072'),
      maxOutputTokens: String(model.maxOutputTokens || '16384'),
      supportsImages: model.supportsImages === true,
      channelsJson: channels.length > 1 ? JSON.stringify(channels, null, 2) : ''
    })
    setStatus(`正在编辑 ${String(model.label || model.id || '')}`)
  }

  function updateDraftChannels(channels: Array<Record<string, unknown>>): void {
    const first = asRecord(channels[0])
    setDraft({
      ...draft,
      provider: String(first.provider || ''),
      upstreamModel: modelOf(first),
      protocol: String(first.protocol || draft.protocol),
      reasoningLevel: String(first.reasoningLevel || draft.reasoningLevel || 'off'),
      strategy: 'priority',
      channelsJson: channels.length > 1 ? JSON.stringify(channels, null, 2) : ''
    })
    setStatus('已更新渠道优先级草稿，保存后生效')
  }

  function promoteDraftChannel(index: number): void {
    const { channels, error } = parseDraftChannels(draft)
    if (error || index <= 0 || index >= channels.length) return
    const next = [...channels]
    const [item] = next.splice(index, 1)
    next.unshift(item)
    updateDraftChannels(next)
  }

  function moveDraftChannel(index: number, direction: -1 | 1): void {
    const { channels, error } = parseDraftChannels(draft)
    const target = index + direction
    if (error || target < 0 || target >= channels.length) return
    const next = [...channels]
    const item = next[index]
    next[index] = next[target]
    next[target] = item
    updateDraftChannels(next)
  }

  async function save(): Promise<void> {
    if (!draft.id.trim() || !draft.provider.trim() || !draft.upstreamModel.trim()) {
      setError('模型 UID、Provider 和上游模型必填')
      return
    }
    let channels: unknown[] = [
      {
        provider: draft.provider.trim(),
        upstreamModel: draft.upstreamModel.trim(),
        protocol: draft.protocol,
        reasoningLevel: draft.reasoningLevel
      }
    ]
    if (draft.channelsJson.trim()) {
      try {
        const parsed: unknown = JSON.parse(draft.channelsJson)
        if (!Array.isArray(parsed) || parsed.length === 0)
          throw new Error('channels 必须是非空数组')
        channels = parsed
      } catch (cause) {
        setError(
          cause instanceof Error ? `备用渠道 JSON 无效：${cause.message}` : '备用渠道 JSON 无效'
        )
        return
      }
    }
    setBusy(true)
    setError('')
    try {
      await api.request('/origin/ea/custom-model', 'POST', {
        id: draft.id.trim(),
        label: draft.label.trim() || draft.id.trim(),
        channels,
        protocol: draft.protocol,
        reasoningLevel: draft.reasoningLevel,
        channelStrategy: draft.strategy,
        contextTokens: Number(draft.contextTokens) || 131072,
        maxOutputTokens: Number(draft.maxOutputTokens) || 16384,
        supportsImages: draft.supportsImages
      })
      setStatus(`自定义模型 ${draft.id.trim()} 已保存，并同步到路由与反代目录`)
      setDraft(emptyDraft)
      await refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '自定义模型保存失败')
    } finally {
      setBusy(false)
    }
  }

  async function remove(model: CustomModel): Promise<void> {
    const id = String(model.id || '')
    if (!id) return
    setBusy(true)
    setError('')
    try {
      await api.request(`/origin/ea/custom-model/${encodeURIComponent(id)}`, 'DELETE')
      setStatus(`自定义模型 ${id} 已删除`)
      await refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '自定义模型删除失败')
    } finally {
      setBusy(false)
    }
  }

  const selectedProvider = providers.find((provider) => provider.name === draft.provider)
  const draftChannelState = parseDraftChannels(draft)
  const activeCount = models.filter((model) => runtimeOf(model).state === 'active').length
  const failedCount = models.filter((model) => runtimeOf(model).state === 'failed').length
  const thinkingCount = models.filter(
    (model) => asRecord(model.capabilities).supportsThinking === true
  ).length
  const toolSafeCount = models.filter(
    (model) => asRecord(model.capabilities).supportsTools !== false
  ).length
  if (loading && models.length === 0) return <LoadingState label="正在加载自定义模型…" />

  return (
    <ControlView
      eyebrow="CUSTOM MODELS / 自定义模型"
      title="多渠道自定义模型"
      description="创建一个稳定的对外模型 UID，再为它挂接一个或多个上游渠道。备用渠道 JSON 仅作为当前组件的高级入口，不会偷读完整控制台表单。"
      onRefresh={() => void refresh()}
      loading={loading || busy}
    >
      <ControlPanel title="自定义模型运行态" note="与路由、反代、协议桥同步">
        <ControlReadoutGrid>
          <ControlReadout
            label="已注册"
            value={formatCount(models.length)}
            detail={`${formatCount(providers.length)} 个可选渠道`}
            tone={models.length ? 'brand' : 'muted'}
          />
          <ControlReadout
            label="当前实际使用"
            value={formatCount(activeCount)}
            detail="最近一次真实请求成功"
            tone={activeCount ? 'good' : 'muted'}
          />
          <ControlReadout
            label="失败模型"
            value={formatCount(failedCount)}
            detail="全部备用渠道均失败"
            tone={failedCount ? 'bad' : 'good'}
          />
          <ControlReadout
            label="工具兼容"
            value={`${formatCount(toolSafeCount)}/${formatCount(models.length)}`}
            detail={`${formatCount(thinkingCount)} 个支持思考档位`}
            tone={toolSafeCount === models.length ? 'good' : 'warn'}
          />
        </ControlReadoutGrid>
      </ControlPanel>
      <ControlPanel title="创建或编辑自定义模型" note="保存后自动同步">
        <div className="control-form-grid">
          <ControlField label="模型 UID">
            <input
              value={draft.id}
              onChange={(event) => setDraft({ ...draft, id: event.target.value })}
              placeholder="如 gpt-5-6-sol-custom"
            />
          </ControlField>
          <ControlField label="显示名称">
            <input
              value={draft.label}
              onChange={(event) => setDraft({ ...draft, label: event.target.value })}
              placeholder="给人看的名称"
            />
          </ControlField>
          <ControlField label="首选渠道">
            <select
              value={draft.provider}
              onChange={(event) =>
                setDraft({ ...draft, provider: event.target.value, upstreamModel: '' })
              }
            >
              <option value="">选择渠道</option>
              {providers.map((provider) => (
                <option key={provider.name} value={provider.name}>
                  {provider.name}
                </option>
              ))}
            </select>
          </ControlField>
          <ControlField label="上游真实模型">
            <select
              value={draft.upstreamModel}
              onChange={(event) => setDraft({ ...draft, upstreamModel: event.target.value })}
            >
              <option value="">选择或手输</option>
              {(selectedProvider?.models || []).map((model) => (
                <option key={model} value={model}>
                  {model}
                </option>
              ))}
            </select>
          </ControlField>
          <ControlField label="上游协议">
            <select
              value={draft.protocol}
              onChange={(event) => setDraft({ ...draft, protocol: event.target.value })}
            >
              <option value="">跟随渠道</option>
              <option value="openai-chat">OpenAI Chat</option>
              <option value="openai-responses">Responses</option>
              <option value="anthropic">Anthropic</option>
              <option value="gemini">Gemini</option>
            </select>
          </ControlField>
          <ControlField label="渠道策略">
            <select
              value={draft.strategy}
              onChange={(event) => setDraft({ ...draft, strategy: event.target.value })}
            >
              <option value="priority">按优先级故障转移</option>
              <option value="random">随机首选</option>
            </select>
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
          <ControlField label="上下文 Token">
            <input
              type="number"
              min="1"
              value={draft.contextTokens}
              onChange={(event) => setDraft({ ...draft, contextTokens: event.target.value })}
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
        </div>
        <ControlToggle
          label="支持图片输入"
          checked={draft.supportsImages}
          onChange={(value) => setDraft({ ...draft, supportsImages: value })}
          disabled={busy}
        />
        <ControlField label="备用渠道 JSON（可选，按优先级排列）" wide>
          <textarea
            rows={7}
            value={draft.channelsJson}
            onChange={(event) => setDraft({ ...draft, channelsJson: event.target.value })}
            placeholder='[{"provider":"backup","upstreamModel":"model-id","protocol":"openai-chat","reasoningLevel":"off"}]'
          />
        </ControlField>
        {(draft.channelsJson.trim() || draftChannelState.channels.length > 1) && (
          <div className="channel-priority-editor" aria-label="手动渠道优先级">
            <div className="channel-priority-heading">
              <strong>手动渠道优先级</strong>
              <span>保存后生效</span>
            </div>
            {draftChannelState.error ? (
              <p className="empty-note">JSON 无法解析：{draftChannelState.error}</p>
            ) : (
              <div className="channel-priority-list">
                {draftChannelState.channels.map((channel, index) => (
                  <div className="channel-priority-row" key={`${index}-${channel.provider}`}>
                    <div>
                      <strong>
                        #{index + 1} {String(channel.provider || '未命名渠道')}
                      </strong>
                      <small>
                        {modelOf(channel) || '未设置模型'} ·{' '}
                        {protocolLabel(channel.protocol || draft.protocol)}
                      </small>
                    </div>
                    <div className="control-record-actions">
                      <button
                        className="control-action control-action-quiet"
                        type="button"
                        disabled={busy || index === 0}
                        onClick={() => promoteDraftChannel(index)}
                      >
                        置顶
                      </button>
                      <button
                        className="control-action control-action-quiet"
                        type="button"
                        disabled={busy || index === 0}
                        onClick={() => moveDraftChannel(index, -1)}
                      >
                        上移
                      </button>
                      <button
                        className="control-action control-action-quiet"
                        type="button"
                        disabled={busy || index === draftChannelState.channels.length - 1}
                        onClick={() => moveDraftChannel(index, 1)}
                      >
                        下移
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
        <div className="control-actions-row">
          <ActionButton busy={busy} variant="primary" onClick={() => void save()}>
            保存并同步
          </ActionButton>
          <button
            className="control-action control-action-quiet"
            type="button"
            onClick={() => {
              setDraft(emptyDraft)
              setStatus('已清空模型编辑器')
            }}
          >
            新建
          </button>
        </div>
      </ControlPanel>
      <ControlPanel title="已注册模型" note={`${models.length} 个`}>
        {models.length === 0 ? (
          <ControlListEmpty label="还没有自定义模型。" />
        ) : (
          <div className="control-record-list custom-model-record-list">
            {models.map((model) => {
              const id = String(model.id || '')
              const channels = asArray(model.channels)
              const runtime = runtimeOf(model)
              const runtimeState = runtimeLabel(model)
              const protocolFact = protocolAdjustment(runtime)
              const capabilities = capabilityBadges(model.capabilities)
              const primary = asRecord(channels[0] || model)
              return (
                <article className="control-record-row" key={id}>
                  <div className="control-record-main">
                    <div>
                      <strong>
                        {String(model.label || id)}{' '}
                        <ControlBadge tone={runtimeState.tone}>{runtimeState.label}</ControlBadge>{' '}
                        <ControlBadge tone="brand">②③④⑥ 已同步</ControlBadge>
                      </strong>
                      <small>
                        {id} · {channels.length || 1} 个渠道 ·{' '}
                        {String(model.channelStrategy || 'priority')}
                      </small>
                      <small>
                        {protocolLabel(model.protocol || primary.protocol)} · 思考{' '}
                        {String(
                          model.reasoningLevel ||
                            asRecord(model.capabilities).defaultReasoningLevel ||
                            'off'
                        )}{' '}
                        · 上下文{' '}
                        {formatTokens(
                          model.contextTokens || asRecord(model.capabilities).contextTokens
                        )}{' '}
                        · 输出 {formatTokens(model.maxOutputTokens)} ·{' '}
                        {model.supportsImages === true ? '支持图片' : '纯文本'}
                      </small>
                      <small>
                        {channels
                          .slice(0, 3)
                          .map((item) => {
                            const row = asRecord(item)
                            return `${String(row.provider || '')}/${String(row.upstreamModel || row.model || '')}`
                          })
                          .join(' · ')}
                      </small>
                      {runtime.state === 'active' && (
                        <small>
                          当前实际使用：{String(runtime.provider || '—')} /{' '}
                          {String(runtime.model || '—')} · {String(runtime.source || '主渠道')} ·{' '}
                          {formatDate(runtime.updatedAt)}
                        </small>
                      )}
                      {protocolFact && (
                        <>
                          <small>
                            实际使用 {protocolLabel(protocolFact.actual)}（配置为{' '}
                            {protocolLabel(protocolFact.configured)}）
                          </small>
                          <small>{protocolFact.message}</small>
                        </>
                      )}
                      {runtime.state === 'failed' && (
                        <small>最近运行：全部渠道失败，请检查首选与备用渠道。</small>
                      )}
                      {capabilities.length > 0 && (
                        <span className="control-badge-row">
                          {capabilities.map((badge) => (
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
                      onClick={() => edit(model)}
                    >
                      编辑
                    </button>
                    <button
                      className="control-action control-action-danger"
                      type="button"
                      disabled={busy}
                      onClick={() => void remove(model)}
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
