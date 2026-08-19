import { useEffect, useMemo, useState } from 'react'

import { asRecord } from '@/lib/daoControlApi'

import {
  ActionButton,
  ControlField,
  ControlPanel,
  ControlStatus,
  ControlView,
  LoadingState,
  useDaoApi
} from './ControlPrimitives'
import { ControlBadge, ControlReadout, ControlReadoutGrid } from './ControlReadout'
import { protocolLabel } from './controlDisplay'

type Provider = { name: string; models: string[]; label: string }

function providerRows(value: unknown): Provider[] {
  const providers = asRecord(asRecord(value).providers)
  return Object.entries(providers)
    .filter(([, raw]) => asRecord(raw)._builtin !== true)
    .map(([name, raw]) => {
      const row = asRecord(raw)
      const source = Array.isArray(row.models) ? row.models : row._models
      return {
        name,
        label: String(row._label || name),
        models: (Array.isArray(source) ? source : [])
          .map((item) =>
            typeof item === 'string'
              ? item
              : String(asRecord(item).id || asRecord(item).model || '')
          )
          .filter(Boolean)
      }
    })
}

export function CodexControlView() {
  const api = useDaoApi()
  const [providers, setProviders] = useState<Provider[]>([])
  const [state, setState] = useState<Record<string, unknown>>({})
  const [provider, setProvider] = useState('')
  const [model, setModel] = useState('')
  const [protocol, setProtocol] = useState('openai-responses')
  const [reasoningLevel, setReasoningLevel] = useState('medium')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')

  async function refresh(): Promise<void> {
    setLoading(true)
    setError('')
    try {
      const [overviewRaw, routeRaw] = await Promise.all([
        api.request('/origin/ea/overview'),
        api.request('/origin/codex-hot-route')
      ])
      const nextProviders = providerRows(overviewRaw)
      const next = asRecord(routeRaw)
      setProviders(nextProviders)
      setState(next)
      const nextProvider = String(
        next.provider ||
          (next.codexObserved && asRecord(next.codexObserved).modelProvider) ||
          nextProviders[0]?.name ||
          ''
      )
      setProvider(nextProvider)
      const matching = nextProviders.find((item) => item.name === nextProvider)
      setModel(
        String(
          next.model ||
            (next.codexObserved && asRecord(next.codexObserved).model) ||
            matching?.models[0] ||
            ''
        )
      )
      setProtocol(String(next.protocol || 'openai-responses'))
      setReasoningLevel(String(next.reasoningLevel || 'medium'))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Codex 热路由读取失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void refresh()
  }, [])

  const selectedProvider = useMemo(
    () => providers.find((item) => item.name === provider),
    [providers, provider]
  )
  const active = state.codexConfigManaged === true && state.routeActive === true
  const observed = asRecord(state.codexObserved)
  const observedDifferent =
    state.enabled === true &&
    observed.exists === true &&
    Boolean(observed.model) &&
    String(observed.model) !== String(state.model || '')

  async function apply(): Promise<void> {
    if (!provider || !model) {
      setError('请选择渠道和已探测模型')
      return
    }
    setBusy(true)
    setError('')
    try {
      const result = asRecord(
        await api.request('/origin/codex-hot-route', 'POST', {
          provider,
          model,
          protocol,
          reasoningLevel
        })
      )
      setStatus(
        asRecord(result.codex).restartRequired
          ? '已保存热路由；首次接管需要重启 Codex 一次'
          : 'Codex 热路由已生效'
      )
      await refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Codex 热路由应用失败')
    } finally {
      setBusy(false)
    }
  }

  async function disable(): Promise<void> {
    setBusy(true)
    setError('')
    try {
      await api.request('/origin/codex-hot-route', 'POST', { action: 'disable' })
      setStatus('Codex 热路由已停用，恢复官方配置')
      await refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Codex 热路由停用失败')
    } finally {
      setBusy(false)
    }
  }

  if (loading && Object.keys(state).length === 0)
    return <LoadingState label="正在读取 Codex 热路由状态…" />

  return (
    <ControlView
      eyebrow="CODEX / 热路由"
      title="Codex 热路由"
      description="显式选择 Codex 的上游渠道、真实模型、协议和思考强度；认证缓存与历史会话不由这个组件触碰。"
      onRefresh={() => void refresh()}
      loading={loading || busy}
    >
      <section className="hero-panel">
        <div>
          <p className="workspace-kicker">CODEX HOT ROUTE</p>
          <h2>{active ? '当前已接管 Codex' : '尚未接管 Codex'}</h2>
          <p>
            {active
              ? `${String(state.provider || provider)} / ${String(state.model || model)}`
              : '应用后通过本地稳定 Responses 端点转发'}
          </p>
        </div>
        <span className={`state-pill ${active ? 'state-good' : 'state-muted'}`}>
          {active ? 'ACTIVE' : 'STANDBY'}
        </span>
      </section>
      <ControlReadoutGrid>
        <ControlReadout
          label="保存热路由"
          value={active ? 'ACTIVE' : state.enabled === true ? 'PENDING' : 'OFF'}
          detail={`${String(state.provider || provider || '—')} / ${String(state.model || model || '—')}`}
          tone={active ? 'good' : state.enabled === true ? 'warn' : 'muted'}
        />
        <ControlReadout
          label="实际 Codex"
          value={String(observed.model || '—')}
          detail={`${String(observed.modelProvider || '官方')} · ${String(observed.reasoningLevel || '—')}`}
          tone={observedDifferent ? 'warn' : 'good'}
        />
        <ControlReadout
          label="协议"
          value={protocolLabel(state.protocol)}
          detail={String(state.endpoint || '—')}
          tone="brand"
        />
        <ControlReadout
          label="保护边界"
          value={asRecord(state.preservation).authenticationTouched === false ? '保留' : '未知'}
          detail="认证缓存与历史会话"
          tone={asRecord(state.preservation).authenticationTouched === false ? 'good' : 'warn'}
        />
      </ControlReadoutGrid>
      <ControlPanel title="当前连接" note="只读状态">
        <dl className="control-definition-grid">
          <div>
            <dt>稳定 Base URL</dt>
            <dd>
              <code>{String(state.baseUrl || '—')}</code>
            </dd>
          </div>
          <div>
            <dt>Responses 端点</dt>
            <dd>
              <code>{String(state.endpoint || '—')}</code>
            </dd>
          </div>
          <div>
            <dt>实际 Provider</dt>
            <dd>
              <code>{String(observed.modelProvider || '—')}</code>
            </dd>
          </div>
          <div>
            <dt>实际模型</dt>
            <dd>
              <code>{String(observed.model || '—')}</code>
            </dd>
          </div>
          <div>
            <dt>实际思考强度</dt>
            <dd>
              <code>{String(observed.reasoningLevel || '—')}</code>
            </dd>
          </div>
          <div>
            <dt>实际协议 / 地址</dt>
            <dd>
              <code>
                {String(observed.wireApi || '—')} · {String(observed.baseUrl || '—')}
              </code>
            </dd>
          </div>
          <div>
            <dt>认证与历史</dt>
            <dd>
              {asRecord(state.preservation).authenticationTouched === false
                ? '保留'
                : '未触碰/未知'}
            </dd>
          </div>
        </dl>
      </ControlPanel>
      <ControlPanel title="应用热路由" note="首次接管可能要求重启 Codex">
        {observedDifferent && (
          <p className="control-warning">
            <ControlBadge tone="warn">配置不一致</ControlBadge> Codex
            当前实际模型与已保存热路由不同；应用后会重新接管。
          </p>
        )}
        <div className="control-form-grid">
          <ControlField label="渠道">
            <select
              value={provider}
              onChange={(event) => {
                setProvider(event.target.value)
                setModel('')
              }}
            >
              <option value="">选择渠道</option>
              {providers.map((item) => (
                <option key={item.name} value={item.name}>
                  {item.label} · {item.name}
                </option>
              ))}
            </select>
          </ControlField>
          <ControlField label="真实模型">
            <select value={model} onChange={(event) => setModel(event.target.value)}>
              <option value="">选择模型</option>
              {(selectedProvider?.models || []).map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
          </ControlField>
          <ControlField label="协议">
            <select value={protocol} onChange={(event) => setProtocol(event.target.value)}>
              <option value="openai-responses">OpenAI Responses</option>
              <option value="openai-chat">OpenAI Chat</option>
              <option value="anthropic">Anthropic</option>
              <option value="gemini">Gemini</option>
            </select>
          </ControlField>
          <ControlField label="思考强度">
            <select
              value={reasoningLevel}
              onChange={(event) => setReasoningLevel(event.target.value)}
            >
              {['off', 'low', 'medium', 'high', 'xhigh'].map((level) => (
                <option key={level} value={level}>
                  {level}
                </option>
              ))}
            </select>
          </ControlField>
        </div>
        <div className="control-actions-row">
          <ActionButton busy={busy} variant="primary" onClick={() => void apply()}>
            应用并接管 Codex
          </ActionButton>
          <button
            className="control-action control-action-danger"
            type="button"
            disabled={busy}
            onClick={() => void disable()}
          >
            停用热路由
          </button>
        </div>
        <p className="control-warning">
          这是显式的高影响操作：会备份并更新 ~/.codex/config.toml；不会改动登录凭证或历史会话。
        </p>
      </ControlPanel>
      <ControlStatus message={error || status} error={Boolean(error)} />
    </ControlView>
  )
}
