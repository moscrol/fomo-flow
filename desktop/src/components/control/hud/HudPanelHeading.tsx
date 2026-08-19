import type { ReactNode } from 'react'

export function HudPanelHeading({
  eyebrow,
  title,
  aside
}: {
  eyebrow: string
  title: string
  aside?: ReactNode
}) {
  return (
    <header className="hud-panel-heading">
      <div>
        <span>{eyebrow}</span>
        <h3>{title}</h3>
      </div>
      {aside && <div className="hud-panel-aside">{aside}</div>}
    </header>
  )
}
