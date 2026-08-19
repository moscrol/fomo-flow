import { useEffect, useState } from 'react'

import {
  ControlField,
  ControlPanel,
  ControlStatus,
  ControlView,
  LoadingState,
  useDaoApi
} from './ControlPrimitives'
import { desktopHost } from '@/lib/desktopHost'
import { asRecord } from '@/lib/daoControlApi'

type EssenceState = {
  mode: string
  validModes: string[]
  canon: string
  canonName: string
  canonMap: Record<string, string>
  preview: string
  customSp: string
  hasCustom: boolean
}

const initialState: EssenceState = {
  mode: 'invert',
  validModes: ['invert', 'passthrough'],
  canon: 'laozi+yinfu',
  canonName: '加载中…',
  canonMap: {},
  preview: '',
  customSp: '',
  hasCustom: false
}

export function EssenceControlView() {
  const api = useDaoApi()
  const [state, setState] = useState(initialState)
  const [draft, setDraft] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')

  async function refresh(): Promise<void> {
    setLoading(true)
    setError('')
    try {
      const [modeRaw, canonRaw, previewRaw, customRaw] = await Promise.all([
        api.request('/origin/mode'),
        api.request('/origin/canon'),
        api.request('/origin/preview'),
        api.request('/origin/custom_sp')
      ])
      const mode = asRecord(modeRaw)
      const canon = asRecord(canonRaw)
      const preview = asRecord(previewRaw)
      const custom = asRecord(customRaw)
      const next = {
        mode: typeof mode.mode === 'string' ? mode.mode : 'invert',
        validModes: Array.isArray(mode.valid)
          ? mode.valid.filter((item): item is string => typeof item === 'string')
          : [],
        canon: typeof canon.canon === 'string' ? canon.canon : 'laozi+yinfu',
        canonName: typeof canon.canon_name === 'string' ? canon.canon_name : '未选择',
        canonMap: asRecord(canon.map) as Record<string, string>,
        preview: typeof preview.after === 'string' ? preview.after : '',
        customSp:
          typeof custom.sp === 'string'
            ? custom.sp
            : typeof custom.default_sp === 'string'
              ? custom.default_sp
              : '',
        hasCustom: custom.has_custom === true
      }
      setState(next)
      setDraft(next.customSp)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '本源状态读取失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void refresh()
  }, [])

  async function runAction(action: () => Promise<unknown>, success: string): Promise<void> {
    setBusy(true)
    setError('')
    setStatus('')
    try {
      await action()
      setStatus(success)
      await refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '操作失败')
    } finally {
      setBusy(false)
    }
  }

  async function copyHandoff(): Promise<void> {
    await runAction(async () => {
      const content = await api.request<string>('/origin/ea/handoff.md')
      await desktopHost().writeClipboard(content)
    }, '交接文档已复制')
  }

  async function saveHandoff(): Promise<void> {
    await runAction(async () => {
      const content = await api.request<string>('/origin/ea/handoff.md')
      await desktopHost().saveHandoff(content, 'fomo-flow-handoff.md')
    }, '交接文档已交给保存对话框')
  }

  if (loading && !state.preview) return <LoadingState label="正在加载注入模式与系统提示词…" />

  return (
    <ControlView
      eyebrow="ESSENCE / 本源"
      title="本源观照"
      description="把注入模式和自定义系统提示词拆成可独立确认的组件。每次保存都会即时落盘并热生效。"
      onRefresh={() => void refresh()}
      loading={loading}
    >
      <ControlPanel title="运行语义" note="立即生效">
        <div className="control-form-grid">
          <ControlField label="注入模式">
            <select
              value={state.mode}
              onChange={(event) => {
                const next = event.target.value
                void runAction(
                  () => api.request('/origin/mode', 'POST', { mode: next }),
                  `模式已切换为 ${next}`
                )
              }}
            >
              {(state.validModes.length ? state.validModes : ['invert', 'passthrough']).map(
                (mode) => (
                  <option key={mode} value={mode}>
                    {mode === 'invert' ? '道 · 本源前置' : '官 · 官方透传'}
                  </option>
                )
              )}
            </select>
          </ControlField>
          <ControlField label="引导包">
            <select
              value={state.canon}
              onChange={(event) =>
                void runAction(
                  () => api.request('/origin/canon', 'POST', { canon: event.target.value }),
                  '引导包已切换'
                )
              }
            >
              {Object.entries(state.canonMap).map(([id, label]) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
              {!Object.keys(state.canonMap).includes(state.canon) && (
                <option value={state.canon}>{state.canonName}</option>
              )}
            </select>
          </ControlField>
        </div>
        <div className="control-inline-note">
          当前引导包：{state.canonName} · 注入模式：{state.mode}
        </div>
      </ControlPanel>

      <ControlPanel
        title="自定义注入 SP"
        note={state.hasCustom ? '已覆盖默认注入' : '当前使用默认注入'}
      >
        <ControlField label="注入文本" wide>
          <textarea value={draft} onChange={(event) => setDraft(event.target.value)} rows={14} />
        </ControlField>
        <div className="control-actions-row">
          <button
            className="control-action control-action-primary"
            type="button"
            disabled={busy || !draft.trim()}
            onClick={() =>
              void runAction(
                () =>
                  api.request('/origin/custom_sp', 'POST', {
                    sp: draft,
                    keep_blocks: true,
                    source: 'desktop-react'
                  }),
                '自定义 SP 已保存，下次请求生效'
              )
            }
          >
            保存注入
          </button>
          <button
            className="control-action control-action-danger"
            type="button"
            disabled={busy || !state.hasCustom}
            onClick={() =>
              void runAction(() => api.request('/origin/custom_sp', 'DELETE'), '已恢复默认本源 SP')
            }
          >
            恢复默认
          </button>
          <span className="control-inline-note">{draft.length.toLocaleString()} 字符</span>
        </div>
      </ControlPanel>

      <ControlPanel title="交接与审阅" note="用户动作才会读取完整文档">
        <div className="control-actions-row">
          <button
            className="control-action control-action-secondary"
            type="button"
            disabled={busy}
            onClick={() => void copyHandoff()}
          >
            复制最新交接文档
          </button>
          <button
            className="control-action control-action-secondary"
            type="button"
            disabled={busy}
            onClick={() => void saveHandoff()}
          >
            保存 Markdown
          </button>
        </div>
        <pre className="control-preview">{state.preview || '尚未捕获到真实请求注入内容。'}</pre>
      </ControlPanel>
      <ControlStatus message={error || status} error={!!error} />
    </ControlView>
  )
}
