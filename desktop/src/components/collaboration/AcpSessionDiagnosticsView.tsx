import { Activity } from 'lucide-react'

import { buildAcpSessionDiagnostics } from './acpSessionDiagnostics'
import type { CollaborationProvider, CollaborationSession } from './collaborationModel'

export function AcpSessionDiagnosticsView({
  session,
  provider,
  now
}: {
  session: CollaborationSession
  provider: CollaborationProvider | undefined
  now: number
}) {
  const facts = buildAcpSessionDiagnostics(session, provider, now)

  return (
    <section className="acp-session-diagnostics" aria-label="会话诊断">
      <div className="collaboration-subheading">
        <span>
          <Activity size={12} aria-hidden="true" /> DIAGNOSTICS / HUD FACTS
        </span>
        <strong>{facts.length} 项</strong>
      </div>
      <div className="collaboration-session-facts acp-session-diagnostics-grid">
        {facts.map((fact) => (
          <article key={fact.label} className={`tone-${fact.tone}`}>
            <span>{fact.label}</span>
            <strong title={fact.value}>{fact.value}</strong>
            <small title={fact.note}>
              <i className="acp-session-diagnostic-marker" aria-hidden="true" />
              {fact.note}
            </small>
          </article>
        ))}
      </div>
    </section>
  )
}
