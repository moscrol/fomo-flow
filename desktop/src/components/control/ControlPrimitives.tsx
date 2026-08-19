import { RefreshCw, Save, Sparkles } from 'lucide-react'
import { type ReactNode, useMemo } from 'react'

import { daoControlApi, type DaoApi } from '@/lib/daoControlApi'

export function useDaoApi(): DaoApi {
  return useMemo(() => daoControlApi(), [])
}

export function ControlView({
  eyebrow,
  title,
  description,
  onRefresh,
  loading,
  children
}: {
  eyebrow: string
  title: string
  description: string
  onRefresh?: () => void
  loading?: boolean
  children: ReactNode
}) {
  return (
    <div className="control-view-stack">
      <div className="control-view-heading">
        <div>
          <p className="workspace-kicker">{eyebrow}</p>
          <h2>{title}</h2>
          <p>{description}</p>
        </div>
        {onRefresh && (
          <button className="secondary-action" type="button" onClick={onRefresh} disabled={loading}>
            <RefreshCw size={14} className={loading ? 'spin' : undefined} aria-hidden="true" />
            刷新
          </button>
        )}
      </div>
      {children}
    </div>
  )
}

export function ControlPanel({
  title,
  note,
  children,
  className = ''
}: {
  title: string
  note?: string
  children: ReactNode
  className?: string
}) {
  return (
    <section className={`data-panel control-panel ${className}`}>
      <div className="panel-heading">
        <div>
          <h3>{title}</h3>
        </div>
        {note && <span className="panel-note">{note}</span>}
      </div>
      {children}
    </section>
  )
}

export function ControlField({
  label,
  children,
  wide = false
}: {
  label: string
  children: ReactNode
  wide?: boolean
}) {
  return (
    <label className={`control-field ${wide ? 'control-field-wide' : ''}`}>
      <span>{label}</span>
      {children}
    </label>
  )
}

export function ActionButton({
  children,
  onClick,
  busy = false,
  variant = 'secondary',
  type = 'button'
}: {
  children: ReactNode
  onClick?: () => void
  busy?: boolean
  variant?: 'primary' | 'secondary' | 'danger' | 'quiet'
  type?: 'button' | 'submit'
}) {
  return (
    <button
      type={type}
      className={`control-action control-action-${variant}`}
      onClick={onClick}
      disabled={busy}
    >
      {busy ? (
        <Sparkles size={14} className="spin" aria-hidden="true" />
      ) : (
        <Save size={14} aria-hidden="true" />
      )}
      {children}
    </button>
  )
}

export function ControlStatus({ message, error = false }: { message: string; error?: boolean }) {
  if (!message) return null
  return <span className={`control-status ${error ? 'is-error' : ''}`}>{message}</span>
}

export function LoadingState({ label = '加载中…' }: { label?: string }) {
  return <p className="empty-note control-loading">{label}</p>
}

export function ControlToggle({
  label,
  checked,
  onChange,
  disabled = false
}: {
  label: string
  checked: boolean
  onChange(value: boolean): void
  disabled?: boolean
}) {
  return (
    <label className="control-toggle">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>{label}</span>
    </label>
  )
}

export function ControlListEmpty({ label = '暂无数据' }: { label?: string }) {
  return <p className="empty-note control-list-empty">{label}</p>
}

export function formatControlValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—'
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}
