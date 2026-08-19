import {
  buildCollaborationActivity,
  formatDuration,
  surfaceLabel,
  taskStatusLabel,
  type CollaborationRequest,
  type CollaborationSession,
  type CollaborationTask
} from './collaborationModel'

const MAX_LINE = 180

function safeLine(value: unknown, fallback = '暂无', limit = MAX_LINE): string {
  if (value === null || value === undefined) return fallback
  const normalized = String(value)
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+/gi, '[凭据已隐藏]')
    .replace(/\bsk-[A-Za-z0-9_-]{4,}/gi, '[凭据已隐藏]')
    .replace(
      /(?:file:\/\/)?(?:\/Users\/|\/home\/|\/private\/|\/var\/|\/tmp\/)[^\s,;)}]+/gi,
      '[路径已隐藏]'
    )
    .replace(/[A-Za-z]:\\[^\s,;)}]+/g, '[路径已隐藏]')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[#>*-]+\s*/, '')
    .slice(0, limit)
  return normalized || fallback
}

function safeDate(value: number | undefined): string {
  const at = Number(value)
  if (!Number.isFinite(at) || at <= 0) return '未知时间'
  try {
    return new Date(at).toISOString()
  } catch {
    return '未知时间'
  }
}

function progressLabel(completed: number, total: number): string {
  return total > 0 ? `${Math.min(Math.max(completed, 0), total)}/${total}` : '未结构化'
}

function sessionSuggestion(session: CollaborationSession): string {
  if (session.todo.current && session.todo.current !== '没有结构化待办') {
    return `继续处理：${safeLine(session.todo.current)}`
  }
  if (session.warning || session.verification.blocking)
    return '先检查当前告警与验证阻塞，再决定是否继续。'
  if (session.active) return '继续观察当前会话活动，等待下一次安全状态更新。'
  return '会话已结束，可审阅活动摘要并确认是否需要后续动作。'
}

function taskSuggestion(task: CollaborationTask): string {
  if (['detached', 'transport_lost'].includes(task.status)) {
    return '先确认传输与心跳状态，再恢复或重新安排执行。'
  }
  if (['failed', 'timed_out', 'cancelled'].includes(task.status)) {
    return '先审阅失败原因与尝试链路，再决定是否重新提交。'
  }
  if (task.status === 'succeeded') return '审阅终态摘要与交接产物，确认结果可被下一位接手者使用。'
  return `继续处理：${safeLine(task.phase || task.progress, '当前任务阶段')}`
}

export function buildSessionHandoff(
  session: CollaborationSession,
  requests: CollaborationRequest[],
  generatedAt = Date.now()
): string {
  const activities = buildCollaborationActivity(session, requests).slice(0, 6)
  const route = session.route.provisional
    ? '正在选择'
    : `${safeLine(session.route.provider, '自动选择', 80)} → ${safeLine(session.route.upstreamModel, '未解析', 100)}`
  const activityLines = activities.length
    ? activities.map((item) => {
        const repeat = item.repeatCount > 1 ? ` ×${item.repeatCount}` : ''
        return `- ${safeLine(item.verb)} · ${safeLine(item.object)} → ${safeLine(item.outcome)}${repeat}（${safeLine(item.detail)}）`
      })
    : ['- 暂无可交接活动。']

  return [
    '# FOMO ACP 会话交接',
    '',
    `生成时间：${safeDate(generatedAt)}`,
    '来源：Dao 原生 ACP 安全投影',
    '',
    '## 当前目标',
    `- 目标：${safeLine(session.goal, '未识别目标')}`,
    `- Surface：${safeLine(surfaceLabel(session.surface))}`,
    `- 工作区：${safeLine(session.workspace, '未标记工作区')}`,
    `- 生命周期：${safeLine(session.lifecycle)} / ${session.active ? '进行中' : '已结束'}`,
    '',
    '## 路由与事实',
    `- 路由：${route}`,
    `- 阶段：${safeLine(session.phase)}`,
    `- 模型路径：${safeLine(session.telemetry.modelPath)}`,
    `- 首字延迟：${formatDuration(session.telemetry.ttftMs)}`,
    `- 轮次耗时：${formatDuration(session.telemetry.durationMs)}`,
    `- 缓存：${session.cache.observed ? `${Math.round(session.cache.hitRate)}% / ${session.cache.calls} 次` : '暂无样本'}`,
    '',
    '## 当前待办',
    `- 进度：${progressLabel(session.todo.completed, session.todo.total)}`,
    `- 当前项：${safeLine(session.todo.current, '没有结构化待办')}`,
    `- 接手建议：${sessionSuggestion(session)}`,
    '',
    '## 最近语义活动',
    ...activityLines,
    '',
    '## 交接边界',
    '- 本包只包含安全摘要，不包含 prompt、密钥、原始 ID、完整路径或 raw 事件。',
    '- 接手建议是人工判断提示，不会自动执行任何任务。'
  ].join('\n')
}

export function buildTaskHandoff(task: CollaborationTask, generatedAt = Date.now()): string {
  const attempts = task.attempts.slice(-5)
  const attemptLines = attempts.length
    ? attempts.map((attempt, index) => {
        const outcome = attempt.errorCategory
          ? `失败：${safeLine(attempt.errorCategory)}`
          : attempt.fallbackUsed
            ? `fallback：${safeLine(attempt.fallbackReason, '策略回退')}`
            : '已记录尝试'
        return `- #${index + 1} ${safeLine(attempt.provider, '未知渠道')} · ${safeLine(attempt.model, '未知模型')} — ${outcome} · ${formatDuration(attempt.durationMs)}`
      })
    : ['- 暂无 Provider 尝试记录。']
  const artifactLines = task.result.artifacts.length
    ? task.result.artifacts.slice(0, 20).map((artifact) => {
        const kind = artifact.kind ? `（${safeLine(artifact.kind, '', 50)}）` : ''
        return `- ${safeLine(artifact.ref, '未命名产物', 140)}${kind}`
      })
    : ['- 当前任务没有可交接产物。']
  const resultStatus =
    task.result.status && task.result.status !== 'unknown'
      ? taskStatusLabel(task.result.status)
      : '尚未产生终态结果'

  return [
    '# Dao 协作任务交接',
    '',
    `生成时间：${safeDate(generatedAt)}`,
    '来源：Dao 协作任务安全投影',
    '',
    '## 任务概况',
    `- 来源：${safeLine(task.source, '未知渠道')}`,
    `- 类型：${safeLine(task.taskType, '未命名任务')}`,
    `- 状态：${taskStatusLabel(task.status)}`,
    `- 工作区：${safeLine(task.workspace, '未标记工作区')}`,
    `- 目标工作区：${safeLine(task.targetWorkspace, '未标记工作区')}`,
    `- 阶段：${safeLine(task.phase)}`,
    `- 进度：${safeLine(task.progress)}`,
    task.recoveryReason ? `- 恢复原因：${safeLine(task.recoveryReason)}` : '',
    '',
    '## 接手建议',
    `- ${taskSuggestion(task)}`,
    '',
    '## 尝试链路',
    ...attemptLines,
    '',
    '## 结果与产物',
    `- 结果：${resultStatus}`,
    `- 标准输出摘要：${safeLine(task.result.stdoutSummary, '暂无标准输出摘要。')}`,
    `- 错误输出摘要：${safeLine(task.result.stderrSummary, '暂无错误输出摘要。')}`,
    ...artifactLines,
    '',
    '## 交接边界',
    '- 本包只包含安全摘要，不包含 prompt、密钥、原始任务 ID、完整路径或完整命令。',
    '- 接手建议是人工判断提示，不会自动取消、重试或启动任务。'
  ].join('\n')
}
