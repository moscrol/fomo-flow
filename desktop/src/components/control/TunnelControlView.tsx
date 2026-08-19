import { useEffect, useState } from 'react'

import { asRecord } from '@/lib/daoControlApi'

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

type TunnelState = Record<string, unknown>

const actions = [
  { action: 'start', label: '启动快速隧道', variant: 'primary' as const },
  { action: 'startNamed', label: '启动固定隧道', variant: 'secondary' as const },
  { action: 'restart', label: '重启隧道', variant: 'secondary' as const },
  { action: 'stop', label: '停止隧道', variant: 'danger' as const }
]

export function TunnelControlView() {
  const api = useDaoApi()
  const [state, setState] = useState<TunnelState>({})
  const [cfToken, setCfToken] = useState('')
  const [cfEmail, setCfEmail] = useState('')
  const [cfKey, setCfKey] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')

  async function refresh(): Promise<void> {
    setLoading(true)
    setError('')
    try {
      setState(asRecord(await api.request('/origin/revproxy/tunnel')))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '隧道状态读取失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void refresh()
    const timer = window.setInterval(() => void refresh(), 8_000)
    return () => window.clearInterval(timer)
  }, [])

  async function runAction(action: string, body: Record<string, unknown> = {}): Promise<void> {
    setBusy(true)
    setError('')
    try {
      const next = asRecord(
        await api.request('/origin/revproxy/tunnel', 'POST', { action, ...body })
      )
      setState(next)
      setStatus(action === 'stop' ? '公网暴露已停止' : `隧道动作 ${action} 已提交`)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '隧道动作失败')
    } finally {
      setBusy(false)
    }
  }

  const running = state.running === true
  const publicUrl = String(state.url || state.publicBase || state.publicUrl || '')

  if (loading && Object.keys(state).length === 0)
    return <LoadingState label="正在读取内网穿透状态…" />

  return (
    <ControlView
      eyebrow="TUNNEL / 内网穿透"
      title="公网端点与隧道"
      description="把本地反代端点逐项暴露到公网。快速隧道、固定域名和 Cloudflare 绑定动作都需要用户明确点击。"
      onRefresh={() => void refresh()}
      loading={loading || busy}
    >
      <section className="hero-panel">
        <div>
          <p className="workspace-kicker">DAO BRIDGE</p>
          <h2>{running ? '隧道已连接' : '隧道未启动'}</h2>
          <p>{publicUrl || '暂无公网 URL'}</p>
        </div>
        <span className={`state-pill ${running ? 'state-good' : 'state-muted'}`}>
          {running ? 'ONLINE' : 'OFFLINE'}
        </span>
      </section>
      <ControlPanel
        title="隧道操作"
        note={String(state.mode || state.named ? '固定域名模式' : '零账号快速模式')}
      >
        <div className="control-actions-row">
          {actions.map((item) => (
            <ActionButton
              key={item.action}
              busy={busy}
              variant={item.variant}
              onClick={() => void runAction(item.action)}
            >
              {item.label}
            </ActionButton>
          ))}
          <button
            className="control-action control-action-quiet"
            type="button"
            disabled={busy}
            onClick={() => void runAction('resetProxy')}
          >
            重置代理探测
          </button>
          <button
            className="control-action control-action-secondary"
            type="button"
            disabled={busy}
            onClick={() => void runAction('relayStart')}
          >
            启动固定中继
          </button>
          <button
            className="control-action control-action-quiet"
            type="button"
            disabled={busy}
            onClick={() => void runAction('relayStop')}
          >
            停止固定中继
          </button>
        </div>
        <dl className="control-definition-grid">
          <div>
            <dt>绑定本地端口</dt>
            <dd>{String(state.boundPort || state.localPort || '—')}</dd>
          </div>
          <div>
            <dt>Cloudflared</dt>
            <dd>{state.bin ? '已就绪' : '启动时自动检查'}</dd>
          </div>
          <div>
            <dt>注册状态</dt>
            <dd>
              {String(
                state.graceRemaining
                  ? `宽限 ${state.graceRemaining}s`
                  : state.backoff
                    ? `退避 ${state.backoff}s`
                    : running
                      ? '公网已暴露'
                      : '未启动'
              )}
            </dd>
          </div>
          <div>
            <dt>Cloudflare 凭证</dt>
            <dd>
              {state.cfLoggedIn
                ? `已保存${state.cfEmail ? ` · ${String(state.cfEmail)}` : ''}`
                : '未绑定'}
            </dd>
          </div>
        </dl>
      </ControlPanel>
      <ControlPanel title="固定中继与 Cloudflare" note="凭证不会回填">
        <div className="control-form-grid">
          <ControlField label="Cloudflare API Token" wide>
            <input
              type="password"
              value={cfToken}
              onChange={(event) => setCfToken(event.target.value)}
              placeholder="输入后点击绑定并固定"
              autoComplete="off"
            />
          </ControlField>
          <ControlField label="Cloudflare 邮箱（旧登录方式）">
            <input
              value={cfEmail}
              onChange={(event) => setCfEmail(event.target.value)}
              placeholder="可选"
            />
          </ControlField>
          <ControlField label="Tunnel Token / API Key">
            <input
              type="password"
              value={cfKey}
              onChange={(event) => setCfKey(event.target.value)}
              placeholder="用于命名隧道"
              autoComplete="off"
            />
          </ControlField>
        </div>
        <div className="control-actions-row">
          <ActionButton
            busy={busy}
            variant="primary"
            onClick={() => void runAction('bindCf', { token: cfToken })}
          >
            绑定并固定
          </ActionButton>
          <ActionButton
            busy={busy}
            onClick={() => void runAction('cfLogin', { email: cfEmail, key: cfKey })}
          >
            保存旧式凭证
          </ActionButton>
          <button
            className="control-action control-action-danger"
            type="button"
            disabled={busy}
            onClick={() => void runAction('logout')}
          >
            退出并解绑
          </button>
        </div>
        <p className="control-inline-note">
          固定中继：
          {state.relay && asRecord(state.relay).bound
            ? String(asRecord(state.relay).publicUrl || '已绑定，等待连接')
            : '未绑定 API Token'}
        </p>
      </ControlPanel>
      <ControlPanel title="公网调用端点" note="只显示运行时返回值">
        {Object.entries({
          Base: state.publicBase,
          Chat: state.publicChat,
          Responses: state.publicResponses,
          Anthropic: state.publicMessages,
          Gemini: state.publicGemini,
          Models: state.publicModels
        }).every(([, value]) => !value) ? (
          <ControlListEmpty label="启动隧道后这里会显示端点。" />
        ) : (
          <div className="control-endpoint-list">
            {Object.entries({
              Base: state.publicBase,
              Chat: state.publicChat,
              Responses: state.publicResponses,
              Anthropic: state.publicMessages,
              Gemini: state.publicGemini,
              Models: state.publicModels
            }).map(([label, value]) => (
              <div key={label}>
                <span>{label}</span>
                <code>{String(value || '—')}</code>
              </div>
            ))}
          </div>
        )}
      </ControlPanel>
      <ControlStatus message={error || status} error={Boolean(error)} />
    </ControlView>
  )
}
