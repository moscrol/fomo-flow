import { Ban, ExternalLink, FolderOpen, PlugZap, Send, ShieldCheck, Square } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'

import { desktopHost, isDevinHostSnapshot, type DevinHostSnapshot } from '@/lib/desktopHost'

import { ControlBadge, ControlReadout, ControlReadoutGrid } from './ControlReadout'
import {
  ControlField,
  ControlPanel,
  ControlStatus,
  ControlView,
  LoadingState
} from './ControlPrimitives'

const unavailableSnapshot: DevinHostSnapshot = {
  phase: 'unavailable',
  runtimeHealthy: false,
  devinAvailable: false,
  models: [],
  selectedModel: '',
  events: [],
  droppedEventCount: 0,
  error: { code: 'unknown', message: 'Devin 接入只在 FOMO FLOW App 中可用。' }
}

const WORKSPACE_HANDLE = /^[a-f0-9]{32}$/

function conclusion(snapshot: DevinHostSnapshot): { title: string; detail: string; tone: string } {
  return {
    unavailable: {
      title: '未找到 Devin',
      detail: '请安装或更新 macOS 版 Devin，然后重新打开 FOMO FLOW。',
      tone: 'bad'
    },
    runtime_offline: {
      title: 'Dao Runtime 未就绪',
      detail: '先恢复本地运行时，才能让 Devin 请求经过 FOMO FLOW。',
      tone: 'warn'
    },
    ready: {
      title: '可以打开 Devin',
      detail: '默认进入 Devin 原生窗口；FOMO FLOW 在中间观测路由、缓存和会话。',
      tone: 'good'
    },
    starting: { title: '正在连接 Devin', detail: '正在进行本地 ACP 握手。', tone: 'brand' },
    connected: {
      title: 'Devin 已连接',
      detail: '现在可以选择本会话模型并发送任务。',
      tone: 'good'
    },
    running: { title: 'Devin 正在执行', detail: '进度和工具状态会在下方更新。', tone: 'brand' },
    waiting_permission: {
      title: '需要你确认权限',
      detail: 'FOMO FLOW 不会自动批准工具操作。',
      tone: 'warn'
    },
    stopping: { title: '正在停止 Devin', detail: '正在清理本地 ACP 子进程。', tone: 'warn' },
    stopped: {
      title: 'Devin 会话已停止',
      detail: '可以沿用当前目录重新创建一个新会话。',
      tone: 'muted'
    },
    failed: {
      title: 'Devin 接入需要重试',
      detail: snapshot.error?.message || '停止当前会话后可以重新连接。',
      tone: 'bad'
    }
  }[snapshot.phase]
}

function isCreated(snapshot: DevinHostSnapshot): boolean {
  return ['starting', 'connected', 'running', 'waiting_permission', 'stopping'].includes(
    snapshot.phase
  )
}

export function DevinConnectControlView() {
  const host = useMemo(() => desktopHost(), [])
  const alive = useRef(true)
  const [snapshot, setSnapshot] = useState<DevinHostSnapshot | null>(null)
  const [prompt, setPrompt] = useState('')
  const [model, setModel] = useState('')
  const [busy, setBusy] = useState('')
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  function accept(value: unknown): DevinHostSnapshot {
    const safe = isDevinHostSnapshot(value) ? value : unavailableSnapshot
    if (alive.current) {
      setSnapshot(safe)
      setModel((current) =>
        safe.models.some((option) => option.value === current)
          ? current
          : safe.selectedModel || safe.models[0]?.value || ''
      )
    }
    return safe
  }

  async function refresh(): Promise<void> {
    if (!host.getDevinHostStatus) return void accept(unavailableSnapshot)
    setError('')
    try {
      accept(await host.getDevinHostStatus())
    } catch {
      accept(unavailableSnapshot)
    }
  }

  useEffect(() => {
    alive.current = true
    void refresh()
    const unsubscribe = host.subscribeDevinHost?.((value) => accept(value))
    return () => {
      alive.current = false
      unsubscribe?.()
    }
  }, [host])

  async function action(name: string, operation: () => Promise<unknown>): Promise<void> {
    setBusy(name)
    setMessage('')
    setError('')
    try {
      const result = await operation()
      if (isDevinHostSnapshot(result)) accept(result)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Devin 接入操作失败，请重试。')
    } finally {
      if (alive.current) setBusy('')
    }
  }

  if (!snapshot) return <LoadingState label="正在检查 Devin 本地接入条件…" />

  const state = conclusion(snapshot)
  const canConnect = ['ready', 'stopped', 'failed'].includes(snapshot.phase)
  const canPrompt = snapshot.phase === 'connected'

  return (
    <ControlView
      eyebrow="DEVIN / NATIVE APP + HOSTED ACP"
      title="Devin 接入"
      description="默认打开 Devin 原生窗口继续工作；需要时也可显式使用 FOMO FLOW 托管的 ACP 会话。"
      onRefresh={() => void refresh()}
      loading={Boolean(busy)}
    >
      <section className={`devin-connect-conclusion is-${state.tone}`} aria-live="polite">
        <span className="devin-connect-conclusion-icon" aria-hidden="true">
          <PlugZap size={22} />
        </span>
        <div>
          <p className="workspace-kicker">现在能不能用</p>
          <h3>{state.title}</h3>
          <p>{state.detail}</p>
        </div>
        <ControlBadge tone={state.tone as 'good' | 'warn' | 'bad' | 'muted' | 'brand'}>
          {snapshot.phase === 'connected'
            ? '已连接'
            : snapshot.phase === 'running'
              ? '运行中'
              : '本地'}
        </ControlBadge>
      </section>

      <ControlReadoutGrid>
        <ControlReadout
          label="Dao Runtime"
          value={snapshot.runtimeHealthy ? '正常' : '未就绪'}
          detail="模型请求经过本地 FOMO FLOW"
          tone={snapshot.runtimeHealthy ? 'good' : 'warn'}
        />
        <ControlReadout
          label="Devin App"
          value={snapshot.devinAvailable ? '已找到' : '未找到'}
          detail="固定官方应用入口，不接收自定义命令"
          tone={snapshot.devinAvailable ? 'good' : 'bad'}
        />
        <ControlReadout
          label="托管 ACP 模型"
          value={
            snapshot.models.find((option) => option.value === snapshot.selectedModel)?.label ||
            snapshot.selectedModel ||
            '沿用优先级'
          }
          detail="仅高级托管模式使用"
          tone="brand"
        />
        <ControlReadout
          label="托管 ACP 权限"
          value="手动确认"
          detail="高级模式只允许一次或拒绝"
          tone="good"
        />
      </ControlReadoutGrid>

      <ControlPanel title="1. 打开 Devin" note="完整路径只留在主进程">
        <div className="devin-connect-workspace-row">
          <div>
            <strong>{snapshot.workspace?.label || '尚未选择目录'}</strong>
            <p>原生窗口沿用 Devin 自己的设置；FOMO FLOW 只负责打开窗口和观测本机事实。</p>
          </div>
          <button
            className="control-action control-action-secondary"
            type="button"
            disabled={Boolean(busy) || isCreated(snapshot)}
            onClick={() =>
              void action('workspace', async () => {
                const selected = await host.chooseDevinWorkspace?.()
                if (
                  selected &&
                  WORKSPACE_HANDLE.test(selected.handle) &&
                  selected.label.length <= 120
                ) {
                  accept({ ...snapshot, workspace: selected })
                }
                return undefined
              })
            }
          >
            <FolderOpen size={15} aria-hidden="true" />
            选择工作目录
          </button>
        </div>
        {canConnect && (
          <div className="control-actions-row devin-connect-actions">
            <button
              className="control-action control-action-primary"
              type="button"
              disabled={!snapshot.workspace || Boolean(busy)}
              onClick={() =>
                void action('native', async () => {
                  if (!host.openDevinNative) throw new Error('Devin 原生入口不可用')
                  const result = await host.openDevinNative(snapshot.workspace!.handle)
                  if (alive.current) {
                    setMessage(
                      '已打开 Devin 原生窗口。请在 Devin 中发送任务，FOMO FLOW 会继续观测。'
                    )
                  }
                  return result
                })
              }
            >
              <ExternalLink size={15} aria-hidden="true" />
              打开 Devin 原生窗口
            </button>
            <button
              className="control-action control-action-secondary"
              type="button"
              disabled={!snapshot.workspace || Boolean(busy)}
              onClick={() =>
                void action('start', () =>
                  host.startDevinHost
                    ? host.startDevinHost(snapshot.workspace!.handle)
                    : Promise.reject(new Error('Devin 托管 ACP 不可用'))
                )
              }
            >
              <PlugZap size={15} aria-hidden="true" />
              高级：在 FOMO FLOW 托管 ACP
            </button>
          </div>
        )}
        {canConnect && (
          <p className="control-inline-note">
            需要直接在 FOMO FLOW 内发送任务和确认工具权限时，再使用高级托管 ACP；两者相互独立。
          </p>
        )}
      </ControlPanel>

      {isCreated(snapshot) && (
        <ControlPanel title="高级托管：发送任务" note="任务内容不写日志或磁盘">
          {snapshot.models.length ? (
            <ControlField label="本会话使用的模型" wide>
              <select
                aria-label="本会话使用的模型"
                value={model}
                disabled={!canPrompt || Boolean(busy)}
                onChange={(event) => setModel(event.target.value)}
              >
                {snapshot.models.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </ControlField>
          ) : (
            <p className="control-inline-note">
              此 Devin 版本未返回模型选项，将沿用现有路由优先级。
            </p>
          )}
          {snapshot.selectedModel && (
            <p className="devin-connect-model-note">
              当前模型：
              {snapshot.models.find((option) => option.value === snapshot.selectedModel)?.label ||
                snapshot.selectedModel}
            </p>
          )}
          <ControlField label="告诉 Devin 要完成什么" wide>
            <textarea
              aria-label="告诉 Devin 要完成什么"
              rows={5}
              maxLength={65_536}
              value={prompt}
              disabled={!canPrompt || Boolean(busy)}
              placeholder="例如：检查当前项目测试失败的原因，并给出最小修复。"
              onChange={(event) => setPrompt(event.target.value)}
            />
          </ControlField>
          <div className="control-actions-row devin-connect-actions">
            <button
              className="control-action control-action-primary"
              type="button"
              disabled={!canPrompt || !prompt.trim() || Boolean(busy)}
              onClick={() =>
                void action('prompt', async () => {
                  const result = host.promptDevinHost
                    ? await host.promptDevinHost(prompt, model || undefined)
                    : Promise.reject(new Error('Devin 接入不可用'))
                  if (alive.current) setPrompt('')
                  return result
                })
              }
            >
              <Send size={15} aria-hidden="true" />
              发送给 Devin
            </button>
            {(snapshot.phase === 'running' || snapshot.phase === 'waiting_permission') && (
              <button
                className="control-action control-action-secondary"
                type="button"
                disabled={Boolean(busy)}
                onClick={() =>
                  void action('cancel', () =>
                    host.cancelDevinHost
                      ? host.cancelDevinHost()
                      : Promise.reject(new Error('Devin 接入不可用'))
                  )
                }
              >
                <Ban size={15} aria-hidden="true" />
                取消当前任务
              </button>
            )}
            <button
              className="control-action control-action-danger"
              type="button"
              disabled={Boolean(busy) || snapshot.phase === 'stopping'}
              onClick={() =>
                void action('stop', () =>
                  host.stopDevinHost
                    ? host.stopDevinHost()
                    : Promise.reject(new Error('Devin 接入不可用'))
                )
              }
            >
              <Square size={14} aria-hidden="true" />
              停止 Devin 会话
            </button>
          </div>
        </ControlPanel>
      )}

      {snapshot.permission && (
        <ControlPanel title="需要你的确认" note="不会自动批准" className="devin-connect-permission">
          <div className="devin-connect-permission-copy">
            <ShieldCheck size={22} aria-hidden="true" />
            <div>
              <strong>{snapshot.permission.category}</strong>
              <p>{snapshot.permission.message}</p>
            </div>
          </div>
          <div className="control-actions-row">
            {snapshot.permission.allowOnce && (
              <button
                className="control-action control-action-primary"
                type="button"
                disabled={Boolean(busy)}
                onClick={() =>
                  void action('permission', () =>
                    host.respondDevinPermission
                      ? host.respondDevinPermission(snapshot.permission!.id, 'allow_once')
                      : Promise.reject(new Error('权限响应不可用'))
                  )
                }
              >
                <ShieldCheck size={15} aria-hidden="true" />
                允许一次
              </button>
            )}
            <button
              className="control-action control-action-danger"
              type="button"
              disabled={Boolean(busy)}
              onClick={() =>
                void action('permission', () =>
                  host.respondDevinPermission
                    ? host.respondDevinPermission(snapshot.permission!.id, 'reject')
                    : Promise.reject(new Error('权限响应不可用'))
                )
              }
            >
              <Ban size={15} aria-hidden="true" />
              拒绝
            </button>
          </div>
        </ControlPanel>
      )}

      {isCreated(snapshot) && (
        <ControlPanel title="托管 ACP 会话进展" note={`最近 ${snapshot.events.length} 条安全事件`}>
          {snapshot.events.length ? (
            <ol className="devin-connect-event-list" aria-label="Devin 会话进展">
              {snapshot.events.map((event) => (
                <li key={event.id} className={`is-${event.status}`}>
                  <span>
                    {event.kind === 'message' ? '回复' : event.kind === 'tool' ? '工具' : '进展'}
                  </span>
                  <p>{event.message}</p>
                </li>
              ))}
            </ol>
          ) : (
            <p className="empty-note">连接并发送任务后，这里会显示回复、计划与工具状态。</p>
          )}
          {snapshot.droppedEventCount > 0 && (
            <p className="control-inline-note">
              更早的 {snapshot.droppedEventCount} 条事件已折叠。
            </p>
          )}
        </ControlPanel>
      )}

      <ControlStatus message={error || message} error={Boolean(error)} />
    </ControlView>
  )
}
