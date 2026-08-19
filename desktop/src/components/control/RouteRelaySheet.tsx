import { useEffect, useState } from 'react'

import { formatRelayRecovery, type RouteRelayHop } from '@/lib/routeRelay'

export function RouteRelaySheet({ hops }: { hops: RouteRelayHop[] }) {
  const [snapshotAt, setSnapshotAt] = useState(() => Date.now())
  const [clock, setClock] = useState(() => Date.now())

  useEffect(() => {
    const now = Date.now()
    setSnapshotAt(now)
    setClock(now)
    const maxRemaining = Math.max(
      0,
      ...hops.map((hop) => (hop.remainingMs === null ? 0 : hop.remainingMs))
    )
    if (maxRemaining === 0) return
    const expiresAt = now + maxRemaining
    const timer = window.setInterval(() => {
      const nextClock = Date.now()
      setClock(nextClock)
      if (nextClock >= expiresAt) window.clearInterval(timer)
    }, 1_000)
    return () => window.clearInterval(timer)
  }, [hops])

  return (
    <section className="decision-center-relay" aria-labelledby="route-relay-title">
      <div className="decision-center-relay-heading">
        <h4 id="route-relay-title">路由接力单</h4>
        <small>严格沿用规定优先级，只说明本次谁能接、谁会被跳过。</small>
      </div>
      {hops.length === 0 ? (
        <p className="empty-note">没有可显示的规定渠道。</p>
      ) : (
        <ol>
          {hops.map((hop) => {
            const remaining =
              hop.remainingMs === null ? null : Math.max(0, hop.remainingMs - (clock - snapshotAt))
            const recovery =
              remaining === null
                ? ''
                : remaining <= 0
                  ? '恢复窗口已到，请重新检查'
                  : formatRelayRecovery(remaining)
            return (
              <li
                className={hop.state === 'ready' ? 'is-ready' : `is-${hop.state}`}
                key={`${hop.actualPriority}:${hop.provider}:${hop.model}`}
              >
                <div>
                  <strong>{`规定 #${hop.actualPriority} · ${routeName(hop)}`}</strong>
                  <span>{relayStatus(hop)}</span>
                </div>
                {hop.state !== 'ready' && (
                  <div className="decision-center-relay-reason">
                    <small>{[hop.reasonLabel, hop.circuitLabel].filter(Boolean).join(' · ')}</small>
                    {recovery && <small>{recovery}</small>}
                  </div>
                )}
              </li>
            )
          })}
        </ol>
      )}
    </section>
  )
}

function routeName(hop: RouteRelayHop): string {
  return [hop.provider, hop.model].filter(Boolean).join(' · ') || '未命名渠道'
}

function relayStatus(hop: RouteRelayHop): string {
  if (hop.state === 'skipped') return '本次跳过'
  if (hop.state === 'blocked') return '预算阻止发送'
  if (hop.dispatchPosition === 1) return '可尝试 · 预计第一跳'
  if (hop.dispatchPosition && hop.dispatchPosition > 1) {
    return `可尝试 · 后备第 ${hop.dispatchPosition - 1} 跳`
  }
  return '可尝试'
}
