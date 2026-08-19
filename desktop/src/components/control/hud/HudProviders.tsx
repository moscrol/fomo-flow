import {
  formatAge,
  formatInteger,
  formatLatency,
  formatPercent,
  providerStateLabel
} from './hudFormatters'
import { HudPanelHeading } from './HudPanelHeading'
import { hudToneForProvider, type HudProvider } from './hudProjection'

export function HudProviders({ providers }: { providers: HudProvider[] }) {
  return (
    <section className="hud-panel hud-providers-panel" aria-label="渠道健康">
      <HudPanelHeading
        eyebrow="CHANNELS · 渠道缓存统计"
        title="渠道健康"
        aside={<span className="hud-count-chip">{providers.length}</span>}
      />
      {providers.length === 0 ? (
        <p className="hud-empty">尚无渠道运行数据</p>
      ) : (
        <div className="hud-provider-list" role="list" aria-label="渠道列表">
          {providers.map((provider) => {
            const tone = hudToneForProvider(provider.state)
            return (
              <article className="hud-provider-item" key={provider.id} role="listitem">
                <header>
                  <div>
                    <i className={`hud-state-dot hud-tone-${tone}`} aria-hidden="true" />
                    <strong>{provider.id}</strong>
                  </div>
                  <span className={`hud-state-label hud-tone-${tone}`}>
                    {providerStateLabel(provider.state)}
                  </span>
                </header>
                <p title={provider.model}>{provider.model}</p>
                <div className="hud-provider-metrics">
                  {provider.recentCalls > 0 && (
                    <Metric label="近期 HIT" value={formatPercent(provider.recentHitRate)} />
                  )}
                  <Metric
                    label="累计 HIT"
                    value={provider.calls > 0 ? formatPercent(provider.hitRate) : '—'}
                  />
                  <Metric label="CALLS" value={formatInteger(provider.calls)} />
                  <Metric label="AGE" value={provider.ageMs ? formatAge(provider.ageMs) : '—'} />
                  <Metric label="P50" value={formatLatency(provider.latency.overall.p50TtftMs)} />
                  <Metric label="P95" value={formatLatency(provider.latency.overall.p95TtftMs)} />
                  <Metric
                    label="HIT/MISS P95"
                    value={`${formatLatency(provider.latency.cache.hit.p95TtftMs)} / ${formatLatency(provider.latency.cache.miss.p95TtftMs)}`}
                    wide
                  />
                </div>
                {provider.circuit && (
                  <small className="hud-provider-circuit">
                    {provider.circuit.category} · {formatAge(provider.circuit.remainingMs)}{' '}
                    remaining
                  </small>
                )}
              </article>
            )
          })}
        </div>
      )}
    </section>
  )
}

function Metric({ label, value, wide = false }: { label: string; value: string; wide?: boolean }) {
  return (
    <span className={wide ? 'is-wide' : ''}>
      <small>{label}</small>
      <strong title={value}>{value}</strong>
    </span>
  )
}
