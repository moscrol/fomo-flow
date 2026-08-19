import type { DaoViewId } from '@/lib/views'

export type SectionShellItem = {
  id: DaoViewId
  label: string
}

export function SectionShellNav({
  label,
  activeView,
  items,
  onSelect
}: {
  label: string
  activeView: DaoViewId
  items: SectionShellItem[]
  onSelect(view: DaoViewId): void
}) {
  return (
    <nav className="section-shell-nav" aria-label={label}>
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          aria-current={activeView === item.id ? 'page' : undefined}
          onClick={() => onSelect(item.id)}
        >
          {item.label}
        </button>
      ))}
    </nav>
  )
}
