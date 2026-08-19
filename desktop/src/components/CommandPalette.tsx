import { useEffect, useMemo, useRef, useState } from 'react'

import type { DaoViewDefinition, DaoViewId } from '@/lib/views'
import { DAO_VIEW_DEFINITIONS, shellViewFor } from '@/lib/views'

export function CommandPalette({
  open,
  views,
  onSelect,
  onClose
}: {
  open: boolean
  views: DaoViewDefinition[]
  onSelect(view: DaoViewId): void
  onClose(): void
}) {
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const matches = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase()
    if (!normalized) return views
    return views.filter((view) =>
      `${view.label} ${view.description} ${view.eyebrow}`.toLocaleLowerCase().includes(normalized)
    )
  }, [query, views])

  useEffect(() => {
    if (!open) return
    setQuery('')
    setActiveIndex(0)
    queueMicrotask(() => inputRef.current?.focus())
  }, [open])

  if (!open) return null

  function selectActive(): void {
    const selected = matches[activeIndex]
    if (selected) onSelect(selected.id)
  }

  return (
    <div className="command-backdrop" role="presentation" onMouseDown={onClose}>
      <div
        className="command-palette"
        role="dialog"
        aria-modal="true"
        aria-label="Dao 命令面板"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <input
          aria-label="搜索命令或视图"
          placeholder="搜索命令或视图"
          ref={inputRef}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value)
            setActiveIndex(0)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') onClose()
            if (event.key === 'ArrowDown') {
              event.preventDefault()
              setActiveIndex((index) => Math.min(index + 1, Math.max(0, matches.length - 1)))
            }
            if (event.key === 'ArrowUp') {
              event.preventDefault()
              setActiveIndex((index) => Math.max(0, index - 1))
            }
            if (event.key === 'Enter') {
              event.preventDefault()
              selectActive()
            }
          }}
        />
        <div className="command-results" role="listbox" aria-label="视图结果">
          {matches.map((view, index) => {
            const owner = DAO_VIEW_DEFINITIONS.find(
              (candidate) => candidate.id === shellViewFor(view.id)
            )
            return (
              <button
                className="command-result"
                key={view.id}
                role="option"
                aria-selected={index === activeIndex}
                type="button"
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => onSelect(view.id)}
              >
                <span>{view.label}</span>
                <small>
                  {owner?.label ?? '当前工作'} · {view.description}
                </small>
              </button>
            )
          })}
          {matches.length === 0 && <p className="command-empty">没有匹配的 Dao 视图</p>}
        </div>
      </div>
    </div>
  )
}
