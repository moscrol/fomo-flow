import { HudKpiStrip } from './HudKpiStrip'
import { HudProviders } from './HudProviders'
import { HudRequests, type HudRequestFallback } from './HudRequests'
import { HudRuntimeStrip } from './HudRuntimeStrip'
import { HudSessions, type HudSurfaceFilter } from './HudSessions'
import { HudTasks } from './HudTasks'
import type { HudSnapshot } from './hudProjection'

import './hud.css'

export function HudPresentation({
  snapshot,
  selectedSessionId,
  surfaceFilter,
  now,
  onSelectSession,
  onSelectSurface,
  fallbackTraces = []
}: {
  snapshot: HudSnapshot
  selectedSessionId: string
  surfaceFilter: HudSurfaceFilter
  now: number
  onSelectSession(id: string): void
  onSelectSurface(filter: HudSurfaceFilter): void
  fallbackTraces?: HudRequestFallback[]
}) {
  const warnings = [...snapshot.runtime.componentWarnings]
  if (snapshot.runtime.codex.zeroToolRisk) warnings.unshift('CODEX ZERO-TOOL RISK')
  else if (snapshot.runtime.codex.toolSurfaceState.toLowerCase() === 'critical') {
    warnings.unshift('CODEX TOOL SURFACE CRITICAL')
  } else if (snapshot.runtime.codex.toolSurfaceState.toLowerCase() === 'warn') {
    warnings.unshift('CODEX TOOL SURFACE WARN')
  }

  return (
    <div className="hud-native-stack">
      <HudRuntimeStrip snapshot={snapshot} now={now} />
      <HudKpiStrip snapshot={snapshot} />
      <div className="hud-cockpit-grid">
        <HudSessions
          now={now}
          onSelectSession={onSelectSession}
          onSelectSurface={onSelectSurface}
          providers={snapshot.providers}
          selectedSessionId={selectedSessionId}
          sessions={snapshot.sessions}
          surfaceFilter={surfaceFilter}
        />
        <HudProviders providers={snapshot.providers} />
        <HudTasks tasks={snapshot.tasks} />
        <HudRequests
          fallbackTraces={fallbackTraces}
          requests={snapshot.recentRequests}
          sourceFilter={surfaceFilter}
        />
      </div>
      <footer className={`hud-safety-footer ${warnings.length ? 'has-warning' : ''}`}>
        <span>LOOPBACK ONLY · SANITIZED PROJECTION · NO PROMPTS / KEYS / FULL PATHS</span>
        <strong>{warnings.length ? warnings.join(' · ') : 'RUNTIME CLEAN'}</strong>
      </footer>
    </div>
  )
}
