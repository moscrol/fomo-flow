import { Activity, ShieldCheck } from 'lucide-react'

import { formatAge } from './hudFormatters'
import type { HudSnapshot } from './hudProjection'

export function HudRuntimeStrip({ snapshot, now }: { snapshot: HudSnapshot; now: number }) {
  const runtime = snapshot.runtime
  const codex = runtime.codex
  const critical = codex.zeroToolRisk || codex.toolSurfaceState.toLowerCase() === 'critical'
  const warning = !critical && codex.toolSurfaceState.toLowerCase() === 'warn'
  const connection = runtime.connection === 'live' || runtime.healthy ? 'live' : 'warning'
  const connectionLabel = connection === 'live' ? '实时在线' : '等待运行时'
  const toolsLabel = critical
    ? 'CRITICAL · ZERO TOOLS'
    : `${codex.toolSurfaceState.toUpperCase()} · ${codex.toolSurface} · ${codex.diskToolMode}`

  return (
    <section className="hud-runtime-strip" aria-label="FOMO FLOW HUD 运行状态">
      <div className="hud-runtime-brand">
        <span className="hud-runtime-mark" aria-hidden="true">
          道
        </span>
        <div>
          <strong>DAO WEB HUD</strong>
          <span>LOCAL OPERATIONS · SANITIZED PROJECTION</span>
        </div>
      </div>
      <div className="hud-runtime-live">
        <span className={`hud-connection hud-tone-${connection}`}>
          <i aria-hidden="true" />
          {connectionLabel}
        </span>
        <dl className="hud-runtime-facts">
          <div>
            <dt>MODE</dt>
            <dd>{runtime.mode.toUpperCase()}</dd>
          </div>
          <div>
            <dt>数据源</dt>
            <dd>{runtime.port ? `本机 :${runtime.port}` : '—'}</dd>
          </div>
          <div>
            <dt>AGE</dt>
            <dd>
              {snapshot.generatedAt ? formatAge(Math.max(0, now - snapshot.generatedAt)) : '—'}
            </dd>
          </div>
          <div className={critical ? 'is-danger' : warning ? 'is-warning' : ''}>
            <dt>CODEX TOOLS</dt>
            <dd>{toolsLabel}</dd>
          </div>
        </dl>
      </div>
      <div className="hud-runtime-trust">
        <ShieldCheck size={14} aria-hidden="true" />
        <span>仅本机 · 不渲染提示词、密钥或完整路径</span>
        <Activity size={14} aria-hidden="true" />
      </div>
    </section>
  )
}
