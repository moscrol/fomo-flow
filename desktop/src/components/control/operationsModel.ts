import type { HudSnapshot } from './hud/hudProjection'
import type { DaoDesktopStatus, TaskboardSnapshot } from '@/lib/desktopHost'
import type { DaoViewId } from '@/lib/views'

export type OperationsHealthTone = 'good' | 'warn' | 'bad' | 'unknown'

export type OperationsHealthItemId =
  'runtime' | 'observation' | 'providers' | 'sessions' | 'requests' | 'taskboard'

export type OperationsHealthItem = {
  id: OperationsHealthItemId
  label: string
  tone: OperationsHealthTone
  state: string
  summary: string
  detail: string
  count: number
  observedAt: number
  action: { label: string; view: DaoViewId } | null
}

export type OperationsHealthSnapshot = {
  overall: OperationsHealthTone
  overallLabel: string
  overallDetail: string
  generatedAt: number
  partial: boolean
  items: OperationsHealthItem[]
}

export type OperationsHealthInput = {
  now: number
  status: DaoDesktopStatus | null
  hud: HudSnapshot | null
  taskboard: TaskboardSnapshot | null
}

const HUD_STALE_MS = 15_000
const REQUEST_RECENT_MS = 5 * 60_000

function unknownItem(
  id: OperationsHealthItemId,
  label: string,
  summary: string,
  action: OperationsHealthItem['action']
): OperationsHealthItem {
  return {
    id,
    label,
    tone: 'unknown',
    state: '尚未观测',
    summary,
    detail: '当前没有足够的本地安全事实。',
    count: 0,
    observedAt: 0,
    action
  }
}

function runtimeItem(status: DaoDesktopStatus | null, now: number): OperationsHealthItem {
  if (!status) return unknownItem('runtime', '本地运行时', '尚未读取运行状态', null)
  if (!status.healthy) {
    return {
      id: 'runtime',
      label: '本地运行时',
      tone: 'bad',
      state: '需要处理',
      summary: status.running ? '进程存在，但服务未就绪' : '本地服务未运行',
      detail: '其他观测页面可能暂时没有新数据。',
      count: 0,
      observedAt: now,
      action: null
    }
  }
  return {
    id: 'runtime',
    label: '本地运行时',
    tone: 'good',
    state: '正常',
    summary: status.port ? `运行中 · 本机端口 ${status.port}` : '运行中',
    detail: 'Electron 主进程已连接 Dao runtime。',
    count: 1,
    observedAt: now,
    action: null
  }
}

function observationItem(hud: HudSnapshot | null, now: number): OperationsHealthItem {
  if (!hud || !hud.generatedAt) {
    return unknownItem('observation', '观测数据源', '暂无安全快照', {
      label: '打开实时观测',
      view: 'hud'
    })
  }
  const ageMs = Math.max(0, now - hud.generatedAt)
  const count = hud.sessions.length + hud.tasks.length + hud.recentRequests.length
  if (!hud.runtime.healthy) {
    return {
      id: 'observation',
      label: '观测数据源',
      tone: 'bad',
      state: '不可用',
      summary: 'HUD 数据源报告离线',
      detail: '保留已有事实，但不把旧数据当成实时状态。',
      count,
      observedAt: hud.generatedAt,
      action: { label: '打开实时观测', view: 'hud' }
    }
  }
  if (ageMs > HUD_STALE_MS) {
    return {
      id: 'observation',
      label: '观测数据源',
      tone: 'warn',
      state: '数据陈旧',
      summary: '安全快照超过 15 秒没有更新',
      detail: '当前事实可供参考，但不能视为实时状态。',
      count,
      observedAt: hud.generatedAt,
      action: { label: '打开实时观测', view: 'hud' }
    }
  }
  return {
    id: 'observation',
    label: '观测数据源',
    tone: 'good',
    state: '实时',
    summary: '安全快照持续更新',
    detail: `${count} 条会话、任务与请求事实进入当前快照。`,
    count,
    observedAt: hud.generatedAt,
    action: { label: '打开实时观测', view: 'hud' }
  }
}

function providerItem(hud: HudSnapshot | null): OperationsHealthItem {
  if (!hud || hud.providers.length === 0) {
    return unknownItem('providers', '上游渠道', '尚无渠道健康样本', {
      label: '查看渠道',
      view: 'providers'
    })
  }
  const circuitOpen = hud.providers.filter(
    (provider) => provider.circuit || provider.state === 'circuit-open'
  ).length
  const degraded = hud.providers.filter((provider) => provider.state === 'degraded').length
  const alive = hud.providers.filter((provider) => provider.state === 'alive').length
  const tone: OperationsHealthTone = circuitOpen || degraded ? 'warn' : alive ? 'good' : 'unknown'
  return {
    id: 'providers',
    label: '上游渠道',
    tone,
    state: tone === 'good' ? '正常' : tone === 'warn' ? '需要注意' : '尚未探活',
    summary:
      tone === 'warn'
        ? `${circuitOpen} 个熔断 · ${degraded} 个降级`
        : tone === 'good'
          ? `${alive} 个渠道已有健康证据`
          : '已配置渠道尚无可用健康样本',
    detail: '这里只显示汇总，不自动切换渠道或修改 priority。',
    count: hud.providers.length,
    observedAt: hud.generatedAt,
    action: { label: '查看渠道', view: 'providers' }
  }
}

function sessionItem(hud: HudSnapshot | null): OperationsHealthItem {
  if (!hud) {
    return unknownItem('sessions', 'Agent 会话', '尚未读取会话事实', {
      label: '打开 ACP 协作',
      view: 'collaboration'
    })
  }
  const active = hud.sessions.filter((session) => session.active).length
  const attention = hud.sessions.filter(
    (session) => session.warning || session.stale || session.verification.blocking
  ).length
  return {
    id: 'sessions',
    label: 'Agent 会话',
    tone: attention ? 'warn' : 'good',
    state: attention ? '需要注意' : active ? '正在工作' : '空闲',
    summary: attention
      ? `${attention} 个会话有告警或陈旧事实`
      : active
        ? `${active} 个会话正在活动`
        : '当前没有 Agent 正在运行',
    detail: '会话退役只影响实时展示，不自动终止进程。',
    count: active,
    observedAt: hud.generatedAt,
    action: { label: '打开 ACP 协作', view: 'collaboration' }
  }
}

function requestItem(hud: HudSnapshot | null, now: number): OperationsHealthItem {
  if (!hud || hud.recentRequests.length === 0) {
    return unknownItem('requests', '请求观测', '暂无最近请求样本', {
      label: '查看最近请求',
      view: 'hud'
    })
  }
  const latestAt = hud.recentRequests.reduce((latest, request) => Math.max(latest, request.at), 0)
  const recent = latestAt > 0 && now - latestAt <= REQUEST_RECENT_MS
  return {
    id: 'requests',
    label: '请求观测',
    tone: recent ? 'good' : 'unknown',
    state: recent ? '有近期流量' : '近期空闲',
    summary: recent ? `${hud.recentRequests.length} 条安全请求样本` : '最近 5 分钟没有请求活动',
    detail: '无流量不是故障；发送新请求后会继续更新。',
    count: hud.recentRequests.length,
    observedAt: latestAt,
    action: { label: '查看最近请求', view: 'hud' }
  }
}

function taskboardItem(taskboard: TaskboardSnapshot | null, now: number): OperationsHealthItem {
  if (!taskboard) {
    return unknownItem('taskboard', 'Taskboard', '尚未读取本机任务板', {
      label: '打开当前工作',
      view: 'work'
    })
  }
  const connected = taskboard.state === 'connected'
  return {
    id: 'taskboard',
    label: 'Taskboard',
    tone: connected ? 'good' : 'warn',
    state: connected ? (taskboard.writable ? '已连接' : '只读连接') : '未连接',
    summary: connected
      ? `${taskboard.items.length} 项计划与验收事实`
      : taskboard.state === 'unmapped'
        ? '当前仓库尚未映射 Taskboard'
        : '本机 Taskboard 暂时不可用',
    detail: 'Taskboard 保存长期目标，不代替实时会话状态。',
    count: taskboard.items.length,
    observedAt: now,
    action: { label: '打开当前工作', view: 'work' }
  }
}

export function buildOperationsHealth(input: OperationsHealthInput): OperationsHealthSnapshot {
  const items = [
    runtimeItem(input.status, input.now),
    observationItem(input.hud, input.now),
    providerItem(input.hud),
    sessionItem(input.hud),
    requestItem(input.hud, input.now),
    taskboardItem(input.taskboard, input.now)
  ]
  const required = items.filter((item) => item.id === 'runtime' || item.id === 'observation')
  const overall: OperationsHealthTone = required.some((item) => item.tone === 'bad')
    ? 'bad'
    : items.some((item) => item.tone === 'warn')
      ? 'warn'
      : required.every((item) => item.tone === 'unknown')
        ? 'unknown'
        : 'good'
  return {
    overall,
    overallLabel: {
      good: '整体正常',
      warn: '有需要注意的地方',
      bad: '需要处理',
      unknown: '等待运行事实'
    }[overall],
    overallDetail: {
      good: '本地运行时和观测数据源正常，未发现阻断性问题。',
      warn: '核心服务仍可观察，但至少一个辅助模块需要检查。',
      bad: '本地运行时或观测数据源不可用，请先恢复核心链路。',
      unknown: '尚未读到足够的本机安全事实。'
    }[overall],
    generatedAt: input.now,
    partial: items.some((item) => item.tone === 'unknown'),
    items
  }
}
