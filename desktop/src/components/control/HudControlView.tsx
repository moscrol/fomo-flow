import { useEffect, useState } from 'react'

import { asArray, asRecord } from '@/lib/daoControlApi'

import { HudPresentation } from './hud/HudPresentation'
import type { HudRequestFallback } from './hud/HudRequests'
import { emptyHudSnapshot, toHudSnapshot, type HudSnapshot } from './hud/hudProjection'
import type { HudSurfaceFilter } from './hud/HudSessions'
import {
  ControlListEmpty,
  ControlPanel,
  ControlStatus,
  ControlView,
  LoadingState,
  useDaoApi
} from './ControlPrimitives'

type HudState = {
  snapshot: HudSnapshot
  alerts: unknown[]
  traces: unknown[]
}

const initialState: HudState = { snapshot: emptyHudSnapshot, alerts: [], traces: [] }
const SESSION_STORAGE_KEY = 'dao.desktop.hud.selected-session'

function storedSessionId(): string {
  try {
    return window.localStorage.getItem(SESSION_STORAGE_KEY) ?? ''
  } catch {
    return ''
  }
}

function display(value: unknown, fallback = '—'): string {
  if (typeof value === 'string') {
    return (
      value
        .replaceAll('\u0000', ' ')
        .replaceAll('\n', ' ')
        .replaceAll('\r', ' ')
        .replaceAll('\t', ' ')
        .trim()
        .slice(0, 180) || fallback
    )
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return fallback
}

function requestFallbacks(traces: unknown[]): HudRequestFallback[] {
  return traces.slice(0, 8).map((item) => {
    const row = asRecord(item)
    return {
      at: display(row.updatedAt ?? row.at, '刚刚'),
      source: display(row.source ?? row.surface, '请求链路'),
      provider: display(row.provider ?? row.route, '—'),
      model: display(row.model, '—'),
      state: display(row.state ?? row.status, '已观测')
    }
  })
}

export function HudControlView() {
  const api = useDaoApi()
  const [state, setState] = useState(initialState)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [lastUpdated, setLastUpdated] = useState(0)
  const [now, setNow] = useState(() => Date.now())
  const [selectedSessionId, setSelectedSessionId] = useState(storedSessionId)
  const [surfaceFilter, setSurfaceFilter] = useState<HudSurfaceFilter>('all')

  async function refresh(): Promise<void> {
    setError('')
    try {
      const [snapshot, alerts, traces] = await Promise.all([
        api.request('/origin/hud/snapshot'),
        api.request('/origin/ea/alerts?limit=12'),
        api.request('/origin/ea/traces?limit=12')
      ])
      const projected = toHudSnapshot(snapshot)
      if (projected.version !== 1) throw new Error('HUD 快照版本不受支持')
      setState({
        snapshot: projected,
        alerts: asArray(asRecord(alerts).alerts),
        traces: asArray(asRecord(traces).traces)
      })
      setLastUpdated(Date.now())
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'HUD 数据读取失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void refresh()
    const timer = window.setInterval(() => void refresh(), 3_000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [])

  function selectSession(id: string): void {
    setSelectedSessionId(id)
    try {
      window.localStorage.setItem(SESSION_STORAGE_KEY, id)
    } catch {
      // Persisting a visual selection is optional.
    }
  }

  if (loading && !lastUpdated) return <LoadingState label="正在连接实时运行 HUD…" />

  return (
    <ControlView
      eyebrow="HUD / 实时观测"
      title="实时运行 HUD"
      description="HUD 的全部只读展示层已拆入原生 React 组件：会话、长任务运行、渠道缓存、告警与请求链路都由 Electron 受控读取。"
      onRefresh={() => void refresh()}
      loading={loading}
    >
      <HudPresentation
        now={now}
        onSelectSession={selectSession}
        onSelectSurface={setSurfaceFilter}
        selectedSessionId={selectedSessionId}
        snapshot={state.snapshot}
        surfaceFilter={surfaceFilter}
        fallbackTraces={requestFallbacks(state.traces)}
      />
      <HudControlFeed alerts={state.alerts} traces={state.traces} />
      <ControlStatus message={error} error={Boolean(error)} />
    </ControlView>
  )
}

function HudControlFeed({ alerts, traces }: { alerts: unknown[]; traces: unknown[] }) {
  return (
    <div className="overview-detail-grid hud-control-feed">
      <ControlPanel title="请求链路" note={`${traces.length} 条控制面增量`}>
        {traces.length === 0 ? (
          <ControlListEmpty label="等待第一条真实请求。" />
        ) : (
          <div className="control-event-list">
            {traces.map((item, index) => {
              const row = asRecord(item)
              return (
                <div key={`${display(row.requestId, 'trace')}-${index}`}>
                  <strong>
                    {display(row.requestId ?? row.id ?? row.model, `trace-${index + 1}`)}
                  </strong>
                  <span>
                    {display(row.state ?? row.status, '—')} ·{' '}
                    {display(row.provider ?? row.route, '—')} ·{' '}
                    {display(row.updatedAt ?? row.at, '—')}
                  </span>
                </div>
              )
            })}
          </div>
        )}
      </ControlPanel>
      <ControlPanel title="实时告警" note="本地增量，已受控裁剪">
        {alerts.length === 0 ? (
          <ControlListEmpty label="当前没有新告警。" />
        ) : (
          <div className="control-event-list">
            {alerts.map((item, index) => {
              const row = asRecord(item)
              return (
                <div key={`${display(row.kind ?? row.type, 'alert')}-${index}`}>
                  <strong>{display(row.kind ?? row.type, 'alert')}</strong>
                  <span>{display(row.message ?? row.error, '告警详情不可用')}</span>
                </div>
              )
            })}
          </div>
        )}
      </ControlPanel>
    </div>
  )
}
