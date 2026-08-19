import { AlertTriangle, CheckCircle2, Clock3, FileBox, ListChecks, Unplug } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

import { asRecord } from '@/lib/daoControlApi'

import {
  ControlBadge,
  ControlReadout,
  ControlReadoutGrid
} from '@/components/control/ControlReadout'
import { CollaborationHandoffActions } from '@/components/collaboration/CollaborationHandoffActions'
import { buildTaskHandoff } from '@/components/collaboration/collaborationHandoff'
import {
  ControlListEmpty,
  ControlPanel,
  ControlStatus,
  ControlView,
  LoadingState,
  useDaoApi
} from '@/components/control/ControlPrimitives'
import {
  formatDuration,
  formatRelativeAge,
  normalizeTasks,
  taskStatusLabel,
  taskTone,
  type CollaborationTask
} from '@/components/collaboration/collaborationModel'

type TaskFilter = 'all' | 'running' | 'queued' | 'detached' | 'failed' | 'succeeded'

const FILTERS: Array<{ id: TaskFilter; label: string }> = [
  { id: 'all', label: '全部' },
  { id: 'running', label: '运行中' },
  { id: 'queued', label: '等待中' },
  { id: 'detached', label: '失联' },
  { id: 'failed', label: '失败' },
  { id: 'succeeded', label: '已完成' }
]

function tasksForFilter(tasks: CollaborationTask[], filter: TaskFilter): CollaborationTask[] {
  if (filter === 'all') return tasks
  if (filter === 'detached')
    return tasks.filter((task) => task.status === 'detached' || task.status === 'transport_lost')
  if (filter === 'failed')
    return tasks.filter((task) => ['failed', 'timed_out', 'cancelled'].includes(task.status))
  return tasks.filter((task) => task.status === filter)
}

function statusIcon(status: string) {
  if (status === 'running' || status === 'succeeded') return CheckCircle2
  if (status === 'queued') return Clock3
  if (status === 'detached' || status === 'transport_lost') return Unplug
  return AlertTriangle
}

function displayResult(task: CollaborationTask): string {
  const result = task.result
  if (result.errorCategory) return `${taskStatusLabel(result.status)} · ${result.errorCategory}`
  if (result.status && result.status !== 'unknown') return taskStatusLabel(result.status)
  return '尚未产生终态结果'
}

function taskPresentationTitle(task: CollaborationTask): string {
  return task.taskType.toLocaleLowerCase() === 'codex-turn'
    ? 'Codex turn（运行事实）'
    : task.taskType
}

function taskPresentationSummary(task: CollaborationTask): string {
  if (
    task.taskType.toLocaleLowerCase() === 'codex-turn' &&
    task.commandSummary === '未提供任务摘要'
  ) {
    return 'Codex turn 只保留运行状态，未保存正文。'
  }
  return task.commandSummary
}

export function TaskCenterControlView({ selectedTaskId }: { selectedTaskId?: string } = {}) {
  const api = useDaoApi()
  const [tasks, setTasks] = useState<CollaborationTask[]>([])
  const [counts, setCounts] = useState({
    total: 0,
    queued: 0,
    running: 0,
    detached: 0,
    failed: 0,
    succeeded: 0,
    other: 0
  })
  const [filter, setFilter] = useState<TaskFilter>('all')
  const [selectedId, setSelectedId] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [now, setNow] = useState(() => Date.now())

  async function refresh(): Promise<void> {
    setError('')
    setNotice('')
    try {
      const payload = await api.request('/origin/tasks')
      const normalized = normalizeTasks(payload)
      setTasks(normalized.tasks)
      setCounts(normalized.counts)
      if (selectedTaskId && normalized.tasks.some((task) => task.jobId === selectedTaskId))
        setFilter('all')
      setSelectedId((current) =>
        selectedTaskId && normalized.tasks.some((task) => task.jobId === selectedTaskId)
          ? selectedTaskId
          : normalized.tasks.some((task) => task.jobId === current)
            ? current
            : normalized.tasks[0]?.jobId || ''
      )
    } catch (cause) {
      // Older runtimes may expose the bounded HUD task projection before the
      // full task endpoint. Keep the page useful while making that degradation
      // explicit to the operator.
      try {
        const hud = await api.request('/origin/hud/snapshot')
        const normalized = normalizeTasks({ tasks: asRecord(hud).tasks })
        setTasks(normalized.tasks)
        setCounts(normalized.counts)
        if (selectedTaskId && normalized.tasks.some((task) => task.jobId === selectedTaskId))
          setFilter('all')
        setSelectedId((current) =>
          selectedTaskId && normalized.tasks.some((task) => task.jobId === selectedTaskId)
            ? selectedTaskId
            : normalized.tasks.some((task) => task.jobId === current)
              ? current
              : normalized.tasks[0]?.jobId || ''
        )
        setNotice('任务详情接口暂不可用，当前显示 HUD 摘要。')
      } catch {
        setError(cause instanceof Error ? cause.message : '任务数据读取失败')
        setTasks([])
        setCounts({
          total: 0,
          queued: 0,
          running: 0,
          detached: 0,
          failed: 0,
          succeeded: 0,
          other: 0
        })
      }
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void refresh()
    const refreshTimer = window.setInterval(() => void refresh(), 3_000)
    const clockTimer = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => {
      window.clearInterval(refreshTimer)
      window.clearInterval(clockTimer)
    }
  }, [])

  const visibleTasks = useMemo(() => {
    return tasksForFilter(tasks, filter)
  }, [filter, tasks])
  const selectedTask = visibleTasks.find((task) => task.jobId === selectedId) ?? visibleTasks[0]

  if (loading && !tasks.length && !error) return <LoadingState label="正在加载协作任务…" />

  return (
    <ControlView
      eyebrow="ACP COLLABORATION / TASK CENTER"
      title="任务中心"
      description="把跨 ACP、Codex 与 Devin 的长任务放进同一条可追踪生命周期：状态、心跳、回退、尝试与交接产物均来自 Dao 的安全投影。"
      onRefresh={() => void refresh()}
      loading={loading}
    >
      <ControlReadoutGrid>
        <ControlReadout label="全部任务" value={counts.total} detail="保留上限 256" tone="brand" />
        <ControlReadout label="运行中" value={counts.running} detail="心跳租约内" tone="good" />
        <ControlReadout
          label="等待 / 失联"
          value={`${counts.queued} / ${counts.detached}`}
          detail="需要关注"
          tone={counts.detached ? 'warn' : 'muted'}
        />
        <ControlReadout
          label="失败 / 完成"
          value={`${counts.failed} / ${counts.succeeded}`}
          detail="终态任务"
          tone={counts.failed ? 'bad' : 'good'}
        />
      </ControlReadoutGrid>

      <div className="collaboration-filter-bar" role="toolbar" aria-label="任务状态筛选">
        <ListChecks size={15} aria-hidden="true" />
        {FILTERS.map((item) => (
          <button
            className="collaboration-filter"
            key={item.id}
            type="button"
            aria-pressed={filter === item.id}
            onClick={() => {
              setFilter(item.id)
              setSelectedId(tasksForFilter(tasks, item.id)[0]?.jobId || '')
            }}
          >
            {item.label}
          </button>
        ))}
        <span className="collaboration-filter-count">{visibleTasks.length} 条</span>
      </div>

      <div className="collaboration-split-grid task-center-grid">
        <ControlPanel
          title="任务队列"
          note={`${visibleTasks.length} 条安全摘要`}
          className="collaboration-list-panel"
        >
          {visibleTasks.length === 0 ? (
            <ControlListEmpty label={error ? '任务读取失败，稍后重试。' : '当前筛选下没有任务。'} />
          ) : (
            <div className="collaboration-task-list" role="list" aria-label="协作任务列表">
              {visibleTasks.map((task) => (
                <TaskRow
                  key={task.jobId}
                  now={now}
                  selected={task.jobId === selectedTask?.jobId}
                  task={task}
                  onSelect={() => setSelectedId(task.jobId)}
                />
              ))}
            </div>
          )}
        </ControlPanel>

        <TaskDetail task={selectedTask} now={now} />
      </div>

      <ControlStatus message={notice || error} error={Boolean(error)} />
    </ControlView>
  )
}

function TaskRow({
  task,
  selected,
  now,
  onSelect
}: {
  task: CollaborationTask
  selected: boolean
  now: number
  onSelect(): void
}) {
  const Icon = statusIcon(task.status)
  return (
    <button
      className={`collaboration-task-row ${selected ? 'is-selected' : ''}`}
      type="button"
      aria-current={selected ? 'true' : undefined}
      onClick={onSelect}
    >
      <span className="collaboration-task-icon" aria-hidden="true">
        <Icon size={16} />
      </span>
      <span className="collaboration-task-main">
        <strong>{taskPresentationTitle(task)}</strong>
        <small>
          {task.workspace} · {task.source.toUpperCase()}
        </small>
        <span>
          {task.phase} · {task.progress}
        </span>
      </span>
      <span className="collaboration-task-side">
        <ControlBadge tone={taskTone(task.status)}>{taskStatusLabel(task.status)}</ControlBadge>
        <small>{formatRelativeAge(now, task.updatedAt)}</small>
      </span>
    </button>
  )
}

function TaskDetail({ task, now }: { task: CollaborationTask | undefined; now: number }) {
  if (!task) {
    return (
      <ControlPanel title="任务详情" note="SELECT A TASK">
        <div className="collaboration-empty-detail">
          <FileBox size={24} aria-hidden="true" />
          <strong>等待任务登记</strong>
          <span>当 ACP 客户端提交长任务后，尝试链路与交接产物会在此出现。</span>
        </div>
      </ControlPanel>
    )
  }

  return (
    <ControlPanel title="任务详情" note={task.jobId} className="collaboration-detail-panel">
      <div className="collaboration-detail-heading">
        <div>
          <p className="workspace-kicker">
            {task.source.toUpperCase()} / {task.taskType}
          </p>
          <h3>{taskPresentationSummary(task)}</h3>
        </div>
        <ControlBadge tone={taskTone(task.status)}>{taskStatusLabel(task.status)}</ControlBadge>
      </div>
      <div className="collaboration-task-facts">
        <span>
          <b>工作区</b>
          {task.workspace}
        </span>
        <span>
          <b>目标</b>
          {task.targetWorkspace}
        </span>
        <span>
          <b>阶段</b>
          {task.phase}
        </span>
        <span>
          <b>更新时间</b>
          {formatRelativeAge(now, task.updatedAt)}
        </span>
        <span>
          <b>心跳</b>
          {task.lastHeartbeatAt ? formatRelativeAge(now, task.lastHeartbeatAt) : '暂无'}
        </span>
        {task.recoveryReason && (
          <span>
            <b>恢复原因</b>
            {task.recoveryReason}
          </span>
        )}
      </div>

      <CollaborationHandoffActions
        content={buildTaskHandoff(task, now)}
        filename="dao-acp-task-handoff.md"
      />

      <section className="collaboration-subsection" aria-label="尝试时间线">
        <div className="collaboration-subheading">
          <span>ATTEMPTS</span>
          <strong>{task.attempts.length || '—'}</strong>
        </div>
        {task.attempts.length === 0 ? (
          <ControlListEmpty label="暂无 Provider 尝试记录。" />
        ) : (
          <div className="collaboration-attempt-list">
            {task.attempts.map((attempt, index) => (
              <article className="collaboration-attempt" key={`${attempt.at}-${index}`}>
                <span
                  className={`collaboration-attempt-marker ${attempt.errorCategory ? 'is-error' : attempt.fallbackUsed ? 'is-fallback' : ''}`}
                />
                <div>
                  <strong>
                    {attempt.provider} · {attempt.model}
                  </strong>
                  <small>
                    {attempt.errorCategory ||
                      (attempt.fallbackUsed
                        ? `fallback · ${attempt.fallbackReason || '策略回退'}`
                        : '已记录尝试')}{' '}
                    · {formatDuration(attempt.durationMs)}
                  </small>
                </div>
                <span className="collaboration-attempt-index">#{index + 1}</span>
              </article>
            ))}
          </div>
        )}
      </section>

      <section className="collaboration-subsection" aria-label="任务结果与产物">
        <div className="collaboration-subheading">
          <span>RESULT / HANDOFF</span>
          <strong>{displayResult(task)}</strong>
        </div>
        <div className="collaboration-result-grid">
          <div>
            <span>STDOUT 摘要</span>
            <p>{task.result.stdoutSummary || '暂无标准输出摘要。'}</p>
          </div>
          <div>
            <span>STDERR 摘要</span>
            <p>{task.result.stderrSummary || '暂无错误输出摘要。'}</p>
          </div>
        </div>
        {task.result.artifacts.length > 0 ? (
          <div className="collaboration-artifact-list" aria-label="交接产物">
            {task.result.artifacts.map((artifact, index) => (
              <span className="collaboration-artifact" key={`${artifact.ref}-${index}`}>
                <FileBox size={13} aria-hidden="true" />
                {artifact.ref}
                {artifact.kind && <small>{artifact.kind}</small>}
              </span>
            ))}
          </div>
        ) : (
          <p className="control-inline-note">当前任务没有可交接产物。</p>
        )}
      </section>
    </ControlPanel>
  )
}
