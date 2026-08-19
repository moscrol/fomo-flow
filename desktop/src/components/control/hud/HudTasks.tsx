import { formatAge, formatInteger, taskState } from './hudFormatters'
import { HudPanelHeading } from './HudPanelHeading'
import { projectHudTaskDesk, type HudTask } from './hudProjection'

export function HudTasks({ tasks }: { tasks: HudTask[] }) {
  const { live, retired } = projectHudTaskDesk(tasks)
  const runningStatuses = new Set(['queued', 'running'])
  const attentionStatuses = new Set(['failed', 'timed_out', 'detached', 'transport_lost'])
  const running = live.filter((task) => runningStatuses.has(task.status.toLowerCase())).length
  const attention = live.filter((task) => attentionStatuses.has(task.status.toLowerCase())).length
  const ended = live.length - running - attention

  return (
    <section className="hud-panel hud-tasks-panel" aria-label="长任务运行情况">
      <HudPanelHeading
        eyebrow="TASK FACTS · 已登记长任务"
        title="长任务运行情况"
        aside={<span className="hud-count-chip">实时 {live.length}</span>}
      />
      <p className="hud-panel-explainer">
        这里只显示最近 5 分钟有心跳的 Dao 登记长任务，不是聊天会话。
      </p>
      <div className="hud-task-summary" aria-label="长任务状态汇总">
        <span>运行中 {running}</span>
        <span>需要处理 {attention}</span>
        <span>已结束 {ended}</span>
        <span>已退役历史 {retired}</span>
      </div>
      {live.length === 0 ? (
        <p className="hud-empty">
          {tasks.length === 0 ? '目前没有 Dao 登记的长任务。' : '当前没有正在心跳的登记任务。'}
        </p>
      ) : (
        <div className="hud-task-list" role="list" aria-label="长任务执行记录">
          {live.map((task) => {
            const state = taskState(task)
            const result = task.result.errorCategory
              ? `${task.result.status} · ${task.result.errorCategory}`
              : task.result.status
            return (
              <article className="hud-task-item" key={task.id} role="listitem">
                <header>
                  <div>
                    <strong title={task.taskType}>{task.taskType}</strong>
                  </div>
                  <span className={`hud-state-pill hud-tone-${state.tone}`}>{state.label}</span>
                </header>
                <div className="hud-task-meta">
                  <span>{task.source.toUpperCase()}</span>
                  <span>{task.phase}</span>
                  <span>心跳 {formatAge(task.freshnessMs)}</span>
                </div>
                <div className="hud-task-progress">
                  <span title={task.progress}>{task.progress}</span>
                  <b>尝试 {formatInteger(task.attemptCount)}</b>
                  {task.fallbackCount > 0 && (
                    <b className="is-warning">备用渠道 {formatInteger(task.fallbackCount)} 次</b>
                  )}
                </div>
                <small className="hud-task-result" title={result}>
                  {result}
                </small>
              </article>
            )
          })}
        </div>
      )}
    </section>
  )
}
