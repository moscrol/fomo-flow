import { Gauge, Network, Server } from 'lucide-react'
import { useMemo } from 'react'

import { ControlBadge } from '@/components/control/ControlReadout'

import {
  buildCollaborationChannelHealth,
  type CollaborationChannelHealthItem
} from './collaborationChannelHealth'
import {
  formatDuration,
  type CollaborationProvider,
  type CollaborationRequest,
  type CollaborationSession
} from './collaborationModel'

function toneLabel(item: CollaborationChannelHealthItem): string {
  if (item.tone === 'bad') return '告警'
  if (item.tone === 'muted') return '待观测'
  return '正常'
}

export function CollaborationChannelHealthView({
  providers,
  sessions,
  recentRequests
}: {
  providers: CollaborationProvider[]
  sessions: CollaborationSession[]
  recentRequests: CollaborationRequest[]
}) {
  const items = useMemo(
    () => buildCollaborationChannelHealth(providers, sessions, recentRequests),
    [providers, sessions, recentRequests]
  )

  return (
    <section className="collaboration-channel-health" aria-label="渠道健康矩阵">
      <div className="collaboration-channel-heading">
        <div>
          <span className="workspace-kicker">
            <Network size={12} aria-hidden="true" /> ROUTING / CHANNEL HEALTH
          </span>
          <h3>渠道健康矩阵</h3>
        </div>
        <strong>{items.length} 个渠道</strong>
      </div>
      {items.length === 0 ? (
        <div className="collaboration-channel-empty">
          <Server size={19} aria-hidden="true" />
          <span>暂无渠道观测</span>
        </div>
      ) : (
        <div className="collaboration-channel-list" role="list" aria-label="渠道健康概览">
          {items.map((item, index) => (
            <ChannelHealthCard item={item} key={`${item.provider}-${index}`} />
          ))}
        </div>
      )}
    </section>
  )
}

function ChannelHealthCard({ item }: { item: CollaborationChannelHealthItem }) {
  return (
    <article className={`collaboration-channel-card tone-${item.tone}`} role="listitem">
      <div className="collaboration-channel-card-heading">
        <span aria-hidden="true">
          <Gauge size={14} />
        </span>
        <strong>{item.provider}</strong>
        <ControlBadge tone={item.tone}>{toneLabel(item)}</ControlBadge>
      </div>
      <div className="collaboration-channel-metrics">
        <span>
          <small>TTFT P95</small>
          <strong>{formatDuration(item.overallP95TtftMs)}</strong>
        </span>
        <span>
          <small>缓存命中 P95</small>
          <strong>{formatDuration(item.cacheHitP95TtftMs)}</strong>
        </span>
        <span>
          <small>缓存未命中 P95</small>
          <strong>{formatDuration(item.cacheMissP95TtftMs)}</strong>
        </span>
      </div>
      <small className="collaboration-channel-status">{item.status}</small>
    </article>
  )
}
