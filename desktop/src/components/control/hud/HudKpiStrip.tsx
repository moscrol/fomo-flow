import { formatCompact, formatInteger, formatPercent } from './hudFormatters'
import type { HudSnapshot } from './hudProjection'

type Kpi = {
  label: string
  value: string
  note: string
  tone?: 'warning' | 'danger'
}

export function HudKpiStrip({ snapshot }: { snapshot: HudSnapshot }) {
  const { totals, cachePolicy, sessions } = snapshot
  const globalCacheObserved = totals.calls > 0 || snapshot.recentRequests.length > 0
  const observedSessionCache = sessions.find((session) => session.cache.observed)
  const cacheHitKpi: Kpi = globalCacheObserved
    ? {
        label: '全局缓存命中',
        value: formatPercent(totals.hitRate),
        note: '近期真实请求的前缀复用效率'
      }
    : observedSessionCache
      ? {
          label: '会话缓存命中',
          value: formatPercent(observedSessionCache.cache.hitRate),
          note: '全局请求样本待累计'
        }
      : {
          label: '全局缓存命中',
          value: '—',
          note: '等待首个真实请求样本'
        }
  const kpis: Kpi[] = [
    {
      label: '活跃会话',
      value: formatInteger(totals.activeSessions),
      note: `${sessions.length} 个已观测 · 每会话隔离`
    },
    cacheHitKpi,
    {
      label: '缓存读取',
      value: formatCompact(totals.cached),
      note: `写入 ${formatCompact(totals.cacheWrite)}`
    },
    {
      label: '告警',
      value: formatInteger(totals.warnings),
      note: '会话、渠道与运行组件',
      tone: totals.warnings > 0 ? 'warning' : undefined
    },
    {
      label: 'Token',
      value: formatCompact(totals.input + totals.output),
      note: `调用 ${formatInteger(totals.calls)}`
    },
    {
      label: '熔断',
      value: formatInteger(totals.openCircuits),
      note: `Warmup ${formatInteger(cachePolicy.activeWarmups)} · 成功 ${formatInteger(cachePolicy.warmupSent)}`,
      tone: totals.openCircuits > 0 ? 'danger' : undefined
    }
  ]

  return (
    <section className="hud-kpi-grid" aria-label="关键指标">
      {kpis.map((kpi, index) => (
        <article
          className={`hud-kpi-card ${kpi.tone ? `hud-kpi-${kpi.tone}` : ''}`}
          key={kpi.label}
        >
          <span className="hud-kpi-index">{String(index + 1).padStart(2, '0')}</span>
          <span>{kpi.label}</span>
          <strong>{kpi.value}</strong>
          <small>{kpi.note}</small>
        </article>
      ))}
    </section>
  )
}
