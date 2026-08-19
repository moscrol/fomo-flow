import { Activity, CircleAlert, GitBranch, PackageCheck, Wrench } from 'lucide-react'
import { useMemo, useState } from 'react'

import { formatRelativeAge } from '@/components/collaboration/collaborationModel'
import {
  deskEventMatchesFilter,
  type DeskEvent,
  type DeskEventFilter,
  type DeskEventState
} from '@/components/work/deskEventModel'
import { ControlBadge, type ControlTone } from './ControlReadout'
import { ActionButton, ControlListEmpty, ControlPanel } from './ControlPrimitives'

const FILTERS: Array<{ id: DeskEventFilter; label: string }> = [
  { id: 'all', label: '全部' },
  { id: 'attention', label: '需要处理' },
  { id: 'traffic', label: '路由与请求' },
  { id: 'progress', label: '进展与产物' }
]

const STATE_PRESENTATION: Record<DeskEventState, { label: string; tone: ControlTone }> = {
  running: { label: '进行中', tone: 'good' },
  waiting: { label: '等待', tone: 'warn' },
  success: { label: '成功', tone: 'good' },
  warning: { label: '需留意', tone: 'warn' },
  failure: { label: '失败', tone: 'bad' },
  retired: { label: '已退役', tone: 'brand' },
  unknown: { label: '待确认', tone: 'muted' }
}

function EventIcon({ event }: { event: DeskEvent }) {
  if (event.state === 'failure' || event.kind === 'approval') {
    return <CircleAlert size={15} aria-hidden="true" />
  }
  if (event.kind === 'request' || event.kind === 'route') {
    return <GitBranch size={15} aria-hidden="true" />
  }
  if (event.kind === 'tool') return <Wrench size={15} aria-hidden="true" />
  if (event.kind === 'artifact') return <PackageCheck size={15} aria-hidden="true" />
  return <Activity size={15} aria-hidden="true" />
}

export function DeskActivityFeed({
  events,
  now,
  healthy,
  onOpenDecisions
}: {
  events: DeskEvent[]
  now: number
  healthy: boolean
  onOpenDecisions?: () => void
}) {
  const [filter, setFilter] = useState<DeskEventFilter>('all')
  const visible = useMemo(
    () => events.filter((event) => deskEventMatchesFilter(event, filter)),
    [events, filter]
  )
  const hasApproval = events.some((event) => event.kind === 'approval')
  const latestAt = events.reduce((latest, event) => Math.max(latest, event.at), 0)
  const feedNote = latestAt
    ? `${events.length} 条 · 最新 ${formatRelativeAge(now, latestAt)}`
    : `${events.length} 条`

  return (
    <section className="desk-activity-region" aria-label="刚刚发生">
      <ControlPanel title="刚刚发生" note={feedNote} className="desk-activity-panel">
        <div className="desk-activity-toolbar" role="toolbar" aria-label="活动筛选">
          {FILTERS.map((item) => (
            <button
              type="button"
              key={item.id}
              className="desk-activity-filter"
              aria-pressed={filter === item.id}
              onClick={() => setFilter(item.id)}
            >
              {item.label}
            </button>
          ))}
          {hasApproval && onOpenDecisions && (
            <ActionButton variant="quiet" onClick={onOpenDecisions}>
              打开待确认事项
            </ActionButton>
          )}
        </div>

        {!healthy && events.length > 0 && (
          <p className="desk-activity-source-note">观测源暂时不可用，下面保留上一次安全活动。</p>
        )}

        {visible.length === 0 ? (
          <ControlListEmpty
            label={
              healthy
                ? filter === 'all'
                  ? '观测正常；刚刚没有新的工作活动。'
                  : '当前筛选没有对应活动。'
                : '工作活动暂时无法读取，稍后将自动重试。'
            }
          />
        ) : (
          <div className="desk-activity-list" role="list" aria-label="工作活动">
            {visible.map((event) => (
              <article
                className={`desk-activity-item state-${event.state} importance-${event.importance}`}
                key={event.key}
                role="listitem"
              >
                <span className="desk-activity-icon" aria-hidden="true">
                  <EventIcon event={event} />
                </span>
                <div className="desk-activity-main">
                  <div className="desk-activity-title-row">
                    <strong>{`${event.actor} ${event.verb} ${event.object}`}</strong>
                    <ControlBadge tone={STATE_PRESENTATION[event.state].tone}>
                      {STATE_PRESENTATION[event.state].label}
                    </ControlBadge>
                  </div>
                  <span className="desk-activity-outcome">{`→ ${event.outcome}`}</span>
                  <small>
                    {event.detail} · {formatRelativeAge(now, event.at)}
                  </small>
                  <details className="desk-activity-evidence">
                    <summary>查看安全证据</summary>
                    <pre>{JSON.stringify(event.evidence, null, 2)}</pre>
                  </details>
                </div>
              </article>
            ))}
          </div>
        )}
      </ControlPanel>
    </section>
  )
}
