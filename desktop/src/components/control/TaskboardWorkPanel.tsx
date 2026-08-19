import { formatRelativeAge } from '@/components/collaboration/collaborationModel'
import type { TaskboardSnapshot, TaskboardWorkItem } from '@/lib/desktopHost'
import { ActionButton, ControlListEmpty, ControlPanel, LoadingState } from './ControlPrimitives'

const STATUS_LABEL: Record<TaskboardWorkItem['status'], string> = {
  blocked: '阻塞',
  in_progress: '进行中',
  in_review: '待验收'
}

const PRIORITY_LABEL: Record<TaskboardWorkItem['priority'], string> = {
  none: '未设优先级',
  urgent: '紧急',
  high: '高优先级',
  medium: '中优先级',
  low: '低优先级'
}

export function TaskboardWorkPanel({
  snapshot,
  loading,
  now,
  onRefresh,
  onConnect
}: {
  snapshot: TaskboardSnapshot
  loading: boolean
  now: number
  onRefresh(): void
  onConnect(): void
}) {
  return (
    <ControlPanel
      title="计划与验收"
      note={`${snapshot.items.length} 项`}
      className="taskboard-work-panel"
    >
      <div className="taskboard-work-heading">
        <p className="empty-note">{snapshot.message}</p>
        <div className="taskboard-work-actions">
          <ActionButton onClick={onRefresh} busy={loading} variant="quiet">
            重试任务板
          </ActionButton>
          {snapshot.state !== 'connected' && (
            <ActionButton onClick={onConnect}>连接本地 Taskboard</ActionButton>
          )}
        </div>
      </div>
      {loading && snapshot.items.length === 0 ? (
        <LoadingState label="正在读取本地计划事项…" />
      ) : snapshot.items.length === 0 ? (
        <ControlListEmpty label="当前仓库没有进行中、阻塞或待验收事项。" />
      ) : (
        <div className="taskboard-work-list" aria-label="计划与验收事项">
          {snapshot.items.map((item) => (
            <article className="taskboard-work-item" key={item.identifier}>
              <div className="taskboard-work-item-heading">
                <strong>{item.title}</strong>
                <span>{STATUS_LABEL[item.status]}</span>
              </div>
              <p className="empty-note">
                {item.identifier} · {PRIORITY_LABEL[item.priority]} ·{' '}
                {formatRelativeAge(now, item.updatedAt)}
              </p>
            </article>
          ))}
        </div>
      )}
    </ControlPanel>
  )
}
