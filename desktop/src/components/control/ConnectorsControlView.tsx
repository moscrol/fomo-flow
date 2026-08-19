import { useState } from 'react'

import { desktopHost } from '@/lib/desktopHost'

import {
  ActionButton,
  ControlPanel,
  ControlStatus,
  ControlView,
  useDaoApi
} from './ControlPrimitives'

export function ConnectorsControlView() {
  const api = useDaoApi()
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')

  async function copyHandoff(): Promise<void> {
    setBusy(true)
    setError('')
    try {
      const text = await api.request<string>('/origin/ea/handoff.md')
      await desktopHost().writeClipboard(text)
      setStatus('最新连接器交接文档已复制')
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
      const text = await api.request<string>('/origin/ea/handoff.md')
      const result = await desktopHost().saveHandoff(text, 'dao-flow-connector-handoff.md')
      setStatus(result.ok ? '连接器交接文档已保存' : '已取消保存')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '交接文档保存失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <ControlView
      eyebrow="CONNECTORS / 连接器"
      title="受控连接器"
      description="这里放 Codex、IDE 和外部客户端的显式接入动作。每项能力独立确认、可回退，不把连接器行为隐藏在页面脚本里。"
    >
      <ControlPanel title="Codex 与 IDE 边界" note="当前工作区">
        <div className="connector-card-grid">
          <article>
            <strong>Codex</strong>
            <p>请在“Codex 连接”组件选择渠道、模型、协议和思考强度。首次接管会备份配置。</p>
            <button
              className="control-action control-action-primary"
              type="button"
              onClick={() =>
                document.querySelector<HTMLButtonElement>('[aria-label="Codex 连接"]')?.click()
              }
            >
              前往 Codex 连接
            </button>
          </article>
          <article>
            <strong>IDE / 外部客户端</strong>
            <p>反代和协议桥会分别生成端点。复制端点后由用户决定接入哪个客户端。</p>
            <button
              className="control-action control-action-secondary"
              type="button"
              onClick={() =>
                document.querySelector<HTMLButtonElement>('[aria-label="接口兼容"]')?.click()
              }
            >
              前往接口兼容
            </button>
          </article>
        </div>
      </ControlPanel>
      <ControlPanel title="运行时与交接" note="不自动写外部配置">
        <div className="control-actions-row">
          <ActionButton busy={busy} variant="secondary" onClick={() => void copyHandoff()}>
            复制交接文档
          </ActionButton>
          <ActionButton busy={busy} onClick={() => void saveHandoff()}>
            保存交接 Markdown
          </ActionButton>
        </div>
        <p className="control-inline-note">
          完整控制台仍可从应用菜单作为兼容入口打开，但主工作区只使用以上原生组件。
        </p>
      </ControlPanel>
      <ControlStatus message={error || status} error={Boolean(error)} />
    </ControlView>
  )
}
