import type { ReactNode } from 'react'
import { Command, RefreshCw } from 'lucide-react'

import { ThemeToggle, type DaoTheme } from '@/components/ThemeToggle'
import type { DaoDesktopStatus } from '@/lib/desktopHost'

export function WorkspaceShell({
  sidebar,
  title,
  description,
  status,
  theme,
  onThemeChange,
  onOpenCommandPalette,
  children
}: {
  sidebar: ReactNode
  title: string
  description: string
  status: DaoDesktopStatus | null
  theme: DaoTheme
  onThemeChange(theme: DaoTheme): void
  onOpenCommandPalette(): void
  children: ReactNode
}) {
  return (
    <div className="workspace-shell">
      {sidebar}
      <main className="workspace-main">
        <header className="workspace-header">
          <div>
            <p className="workspace-kicker">DAO FLOW / {title.toLocaleUpperCase()}</p>
            <h1>{title}</h1>
            <p className="workspace-description">{description}</p>
          </div>
          <div className="workspace-actions">
            <span className={`runtime-chip ${status?.healthy ? 'is-healthy' : ''}`}>
              <span aria-hidden="true" />
              {status?.healthy ? `127.0.0.1:${status.port}` : '运行时未连接'}
            </span>
            <ThemeToggle value={theme} onChange={onThemeChange} />
            <button className="command-trigger" type="button" onClick={onOpenCommandPalette}>
              <Command size={15} aria-hidden="true" />
              <span>跳转</span>
              <kbd>⌘K</kbd>
            </button>
          </div>
        </header>
        {status?.healthy === false && (
          <div className="runtime-notice">
            <RefreshCw size={15} aria-hidden="true" /> 本地运行时暂时不可用，可在总览页重试。
          </div>
        )}
        <section className="workspace-content" aria-label={title}>
          {children}
        </section>
      </main>
    </div>
  )
}
