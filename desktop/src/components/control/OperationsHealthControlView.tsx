import {
  Activity,
  ArrowRight,
  Database,
  ListChecks,
  MessagesSquare,
  Network,
  ServerCog,
  type LucideIcon
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'

import { formatRelativeAge } from '@/components/collaboration/collaborationModel'
import type { HudSnapshot } from '@/components/control/hud/hudProjection'
import { toHudSnapshot } from '@/components/control/hud/hudProjection'
import { desktopHost, type DaoDesktopStatus, type TaskboardSnapshot } from '@/lib/desktopHost'
import type { DaoViewId } from '@/lib/views'

import { ControlBadge, ControlReadout, ControlReadoutGrid } from './ControlReadout'
import {
  ControlPanel,
  ControlStatus,
  ControlView,
  LoadingState,
  useDaoApi
} from './ControlPrimitives'
import {
  buildOperationsHealth,
  type OperationsHealthItemId,
  type OperationsHealthTone
} from './operationsModel'

const ITEM_ICONS: Record<OperationsHealthItemId, LucideIcon> = {
  runtime: ServerCog,
  observation: Database,
  providers: Network,
  sessions: MessagesSquare,
  requests: Activity,
  taskboard: ListChecks
}

function badgeTone(tone: OperationsHealthTone): 'good' | 'warn' | 'bad' | 'muted' {
  if (tone === 'unknown') return 'muted'
  return tone
}

export function OperationsHealthControlView({
  onNavigate
}: {
  onNavigate?: (view: DaoViewId) => void
} = {}) {
  const api = useDaoApi()
  const [status, setStatus] = useState<DaoDesktopStatus | null>(null)
  const [hud, setHud] = useState<HudSnapshot | null>(null)
  const [taskboard, setTaskboard] = useState<TaskboardSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [partialNotice, setPartialNotice] = useState('')
  const [now, setNow] = useState(() => Date.now())
  const refreshSeq = useRef(0)

  async function refresh(): Promise<void> {
    const seq = ++refreshSeq.current
    const host = desktopHost()
    setLoading(true)
    const results = await Promise.allSettled([
      host.getRuntimeStatus(),
      api.request('/origin/hud/snapshot'),
      host.getTaskboardSnapshot ? host.getTaskboardSnapshot() : Promise.resolve(null)
    ])
    if (refreshSeq.current !== seq) return

    const [runtimeResult, hudResult, taskboardResult] = results
    setStatus(runtimeResult.status === 'fulfilled' ? runtimeResult.value : null)
    setHud(hudResult.status === 'fulfilled' ? toHudSnapshot(hudResult.value) : null)
    setTaskboard(taskboardResult.status === 'fulfilled' ? taskboardResult.value : null)
    setPartialNotice(
      results.some((result) => result.status === 'rejected')
        ? '部分数据源暂不可用，其余健康事实仍可查看。'
        : ''
    )
    setNow(Date.now())
    setLoading(false)
  }

  useEffect(() => {
    void refresh()
    const refreshTimer = window.setInterval(() => void refresh(), 5_000)
    const clockTimer = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => {
      refreshSeq.current += 1
      window.clearInterval(refreshTimer)
      window.clearInterval(clockTimer)
    }
  }, [])

  const health = useMemo(
    () => buildOperationsHealth({ now, status, hud, taskboard }),
    [now, status, hud, taskboard]
  )
  const runtimeItem = health.items.find((item) => item.id === 'runtime')
  const providerItem = health.items.find((item) => item.id === 'providers')
  const taskboardItem = health.items.find((item) => item.id === 'taskboard')

  if (loading && !status && !hud && !taskboard) {
    return <LoadingState label="正在读取本机运行健康…" />
  }

  return (
    <ControlView
      eyebrow="OPERATIONS / LOCAL CONTROL PLANE"
      title="运行健康"
      description="本机服务、观测源、上游渠道、Agent 会话、请求与 Taskboard 的当前运行事实。"
      onRefresh={() => void refresh()}
      loading={loading}
    >
      <ControlReadoutGrid>
        <ControlReadout
          label="整体状态"
          value={health.overallLabel}
          detail={health.overallDetail}
          tone={badgeTone(health.overall)}
        />
        <ControlReadout
          label="核心链路"
          value={runtimeItem?.state ?? '尚未观测'}
          detail={runtimeItem?.summary ?? '等待运行事实'}
          tone={badgeTone(runtimeItem?.tone ?? 'unknown')}
        />
        <ControlReadout
          label="上游健康样本"
          value={providerItem?.count ?? 0}
          detail={providerItem?.summary ?? '尚无渠道事实'}
          tone={badgeTone(providerItem?.tone ?? 'unknown')}
        />
        <ControlReadout
          label="长期任务账本"
          value={taskboardItem?.state ?? '尚未观测'}
          detail={taskboardItem?.summary ?? '等待 Taskboard 事实'}
          tone={badgeTone(taskboardItem?.tone ?? 'unknown')}
        />
      </ControlReadoutGrid>

      <ControlPanel
        title="模块健康"
        note={`${health.partial ? '部分观测' : '完整观测'} · ${formatRelativeAge(now, health.generatedAt)}`}
        className="operations-health-panel"
      >
        <div className="operations-health-list" role="list" aria-label="运行模块健康">
          {health.items.map((item) => {
            const Icon = ITEM_ICONS[item.id]
            return (
              <article
                className={`operations-health-row tone-${item.tone}`}
                key={item.id}
                role="listitem"
              >
                <span className="operations-health-icon" aria-hidden="true">
                  <Icon size={17} />
                </span>
                <div className="operations-health-main">
                  <strong>{item.label}</strong>
                  <span>{item.summary}</span>
                  <small>{item.detail}</small>
                </div>
                <div className="operations-health-meta">
                  <ControlBadge tone={badgeTone(item.tone)}>{item.state}</ControlBadge>
                  <small>
                    {item.observedAt ? formatRelativeAge(now, item.observedAt) : '暂无时间证据'}
                  </small>
                </div>
                {item.action && onNavigate && (
                  <button
                    className="secondary-action operations-health-action"
                    type="button"
                    onClick={() => onNavigate(item.action!.view)}
                  >
                    {item.action.label}
                    <ArrowRight size={13} aria-hidden="true" />
                  </button>
                )}
              </article>
            )
          })}
        </div>
      </ControlPanel>

      <p className="operations-health-boundary">
        只读运行事实。不会自动修改 provider、model 或 priority，也不会执行远程命令。
      </p>
      <ControlStatus message={partialNotice} error={health.overall === 'bad'} />
    </ControlView>
  )
}
