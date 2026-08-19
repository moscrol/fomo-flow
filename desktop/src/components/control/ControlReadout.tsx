import type { ReactNode } from 'react'

export type ControlTone = 'good' | 'warn' | 'bad' | 'muted' | 'brand'

export function ControlBadge({
  children,
  tone = 'muted'
}: {
  children: ReactNode
  tone?: ControlTone
}) {
  return <span className={`control-badge control-badge-${tone}`}>{children}</span>
}

export function ControlReadout({
  label,
  value,
  detail,
  tone = 'muted'
}: {
  label: string
  value: ReactNode
  detail?: ReactNode
  tone?: ControlTone
}) {
  return (
    <div className={`control-readout control-readout-${tone}`}>
      <span className="control-readout-label">{label}</span>
      <strong className="control-readout-value">{value}</strong>
      {detail !== undefined && <small className="control-readout-detail">{detail}</small>}
    </div>
  )
}

export function ControlReadoutGrid({ children }: { children: ReactNode }) {
  return <div className="control-readout-grid">{children}</div>
}
