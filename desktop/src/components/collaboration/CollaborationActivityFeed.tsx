import {
  Activity,
  Bot,
  CheckCircle2,
  ChevronDown,
  CircleAlert,
  GitBranch,
  Wrench
} from 'lucide-react'
import { useMemo, useState } from 'react'

import { ControlBadge } from '@/components/control/ControlReadout'
import { ControlListEmpty } from '@/components/control/ControlPrimitives'
import {
  activityFilterLabel,
  activityKindLabel,
  activityMatchesFilter,
  buildCollaborationActivity,
  formatRelativeAge,
  type CollaborationActivityFilter,
  type CollaborationActivityItem,
  type CollaborationRequest,
  type CollaborationSession
} from './collaborationModel'

const ACTIVITY_FILTERS: CollaborationActivityFilter[] = ['all', 'lifecycle', 'operation', 'result']

function ActivityIcon({ item }: { item: CollaborationActivityItem }) {
  if (item.tone === 'bad') return <CircleAlert size={15} aria-hidden="true" />
  if (item.kind === 'lifecycle') return <Bot size={15} aria-hidden="true" />
  if (item.kind === 'route') return <GitBranch size={15} aria-hidden="true" />
  if (item.kind === 'tool') return <Wrench size={15} aria-hidden="true" />
  if (item.kind === 'result') return <CheckCircle2 size={15} aria-hidden="true" />
  return <Activity size={15} aria-hidden="true" />
}

function activityToneClass(item: CollaborationActivityItem): string {
  return `tone-${item.tone}`
}

export function CollaborationActivityFeed({
  session,
  requests,
  now
}: {
  session: CollaborationSession
  requests: CollaborationRequest[]
  now: number
}) {
  const [filter, setFilter] = useState<CollaborationActivityFilter>('all')
  const [rawId, setRawId] = useState('')
  const activities = useMemo(
    () => buildCollaborationActivity(session, requests),
    [session, requests]
  )
  const visibleActivities = activities.filter((item) => activityMatchesFilter(item, filter))

  return (
    <section
      className="collaboration-subsection collaboration-activity-feed"
      aria-label="语义活动流"
    >
      <div className="collaboration-subheading">
        <span>ACTIVITY / SEMANTIC FEED</span>
        <strong>{visibleActivities.length} 条</strong>
      </div>
      <div className="collaboration-activity-toolbar" role="toolbar" aria-label="活动类型筛选">
        {ACTIVITY_FILTERS.map((item) => (
          <button
            className="collaboration-activity-filter"
            key={item}
            type="button"
            aria-pressed={filter === item}
            onClick={() => setFilter(item)}
          >
            {activityFilterLabel(item)}
          </button>
        ))}
      </div>
      {visibleActivities.length === 0 ? (
        <ControlListEmpty label="当前筛选暂无活动。" />
      ) : (
        <div className="collaboration-activity-list" role="list" aria-label="会话语义活动">
          {visibleActivities.map((item) => (
            <article
              className={`collaboration-activity-card ${activityToneClass(item)}`}
              key={item.id}
              role="listitem"
            >
              <span className="collaboration-activity-icon" aria-hidden="true">
                <ActivityIcon item={item} />
              </span>
              <div className="collaboration-activity-main">
                <div className="collaboration-activity-title-row">
                  <strong>
                    {item.verb} · {item.object}
                  </strong>
                  <ControlBadge tone={item.tone}>{activityKindLabel(item.kind)}</ControlBadge>
                </div>
                <span className="collaboration-activity-outcome">
                  {item.outcome}
                  {item.repeatCount > 1 && ` · ×${item.repeatCount}`}
                </span>
                <small>
                  {item.detail} · {formatRelativeAge(now, item.at)}
                </small>
                <details
                  className="collaboration-activity-raw"
                  open={rawId === item.id}
                  onToggle={(event) => {
                    setRawId(event.currentTarget.open ? item.id : '')
                  }}
                >
                  <summary>
                    <ChevronDown size={12} aria-hidden="true" />
                    查看原始事件
                  </summary>
                  <pre>{JSON.stringify(item.raw, null, 2)}</pre>
                </details>
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  )
}
