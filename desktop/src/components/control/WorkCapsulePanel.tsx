import type { ReactNode } from 'react'

import { formatRelativeAge } from '@/components/collaboration/collaborationModel'
import type { WorkCapsule } from '@/components/work/deskEventModel'
import { ActionButton, ControlListEmpty, ControlPanel } from './ControlPrimitives'

export function WorkCapsulePanel({
  capsule,
  now,
  actionLoading,
  onOpenItem,
  onAcknowledge,
  onPromote,
  children
}: {
  capsule: WorkCapsule
  now: number
  actionLoading: boolean
  onOpenItem(): void
  onAcknowledge(): void
  onPromote(): void
  children?: ReactNode
}) {
  const { item, route } = capsule
  const provider = route.provider || '渠道未上报'
  const model = route.upstreamModel || route.modelUid || '模型未上报'
  const routeName = route.modelUid || '路由配置名未上报'
  const hasRouteFact = Boolean(route.provider || route.upstreamModel || route.modelUid)
  const routeStatus = !hasRouteFact
    ? '路由尚未上报'
    : route.provisional
      ? '候选路由，尚未确认'
      : '已观测实际路由'
  const openLabel = item.kind === 'session' ? '打开协作会话' : '打开任务进度'

  return (
    <section className="work-capsule" aria-label="工作舱">
      <ControlPanel title="工作舱" note="一个工作的一组可靠事实" className="work-capsule-summary">
        <div className="work-capsule-heading">
          <div>
            <strong>{item.title}</strong>
            <p>{item.phase}</p>
          </div>
          <span>{`来源 · ${item.source}`}</span>
        </div>

        <dl className="work-capsule-facts">
          <div className="work-capsule-pulse-heading">
            <dt>摘要</dt>
            <dd>工作脉冲</dd>
          </div>
          <div>
            <dt>现在在做</dt>
            <dd>{`现在在做：${capsule.current}`}</dd>
          </div>
          <div>
            <dt>进度</dt>
            <dd>{`进度：${capsule.progress}`}</dd>
          </div>
          <div>
            <dt>最近结果</dt>
            <dd>{`最近结果：${capsule.outcome}`}</dd>
          </div>
          <div>
            <dt>最近活动</dt>
            <dd>{formatRelativeAge(now, item.updatedAt)}</dd>
          </div>
          <div>
            <dt>交接</dt>
            <dd>{capsule.hasHandoff ? '交接摘要已准备' : '交接摘要尚未准备'}</dd>
          </div>
        </dl>

        <div className="work-capsule-events" aria-label="工作舱活动">
          <h4>可靠关联的活动</h4>
          {capsule.events.length === 0 ? (
            <ControlListEmpty label="目前没有可可靠关联到这项工作的活动。" />
          ) : (
            <div role="list">
              {capsule.events.map((event) => (
                <article
                  className={`work-capsule-event state-${event.state}`}
                  key={event.key}
                  role="listitem"
                >
                  <strong>{`${event.actor} ${event.verb} ${event.object} → ${event.outcome}`}</strong>
                  <small>
                    {event.detail} · {formatRelativeAge(now, event.at)}
                  </small>
                </article>
              ))}
            </div>
          )}
        </div>

        <dl className="work-capsule-facts work-capsule-route-facts" aria-label="工作舱路由状态">
          <div>
            <dt>上游路由</dt>
            <dd>{`上游渠道 ${provider} · 上游模型 ${model}`}</dd>
          </div>
          <div>
            <dt>路由配置</dt>
            <dd>{`路由配置名 ${routeName}`}</dd>
          </div>
          <div>
            <dt>路由状态</dt>
            <dd>{routeStatus}</dd>
          </div>
        </dl>
      </ControlPanel>
      {children}
      <ControlPanel title="下一步" note="只有点击后才会执行" className="work-capsule-action-panel">
        <div className="work-capsule-actions">
          {item.bucket === 'attention' && item.fingerprint && (
            <>
              <ActionButton onClick={onAcknowledge} busy={actionLoading}>
                我知道了
              </ActionButton>
              <ActionButton onClick={onPromote}>加入任务板</ActionButton>
            </>
          )}
          <ActionButton variant="primary" onClick={onOpenItem}>
            {openLabel}
          </ActionButton>
        </div>
      </ControlPanel>
    </section>
  )
}
