import {
  Activity,
  BriefcaseBusiness,
  Bot,
  Cable,
  ChartNoAxesCombined,
  Boxes,
  Gauge,
  Inbox,
  ListChecks,
  Network,
  PlugZap,
  Radio,
  Route,
  Search,
  ServerCog,
  Settings2,
  Terminal,
  Waypoints,
  type LucideIcon
} from 'lucide-react'

import { DaoMark } from '@/components/DaoMark'
import type { DaoDesktopStatus } from '@/lib/desktopHost'
import {
  primaryViewDefinitions,
  shellViewFor,
  type DaoViewDefinition,
  type DaoViewId
} from '@/lib/views'

const icons: Record<DaoViewId, LucideIcon> = {
  work: BriefcaseBusiness,
  settings: Settings2,
  decisions: Inbox,
  overview: Gauge,
  hud: Activity,
  devinConnect: Bot,
  collaboration: Waypoints,
  tasks: ListChecks,
  providers: Network,
  routes: Route,
  revproxy: Radio,
  tunnel: Waypoints,
  bridges: Cable,
  customModels: Boxes,
  codex: Terminal,
  observability: ChartNoAxesCombined,
  operations: ServerCog,
  connectors: PlugZap
}

export function Sidebar({
  activeView,
  views,
  status,
  onOpenCommandPalette,
  onSelect
}: {
  activeView: DaoViewId
  views: DaoViewDefinition[]
  status: DaoDesktopStatus | null
  onOpenCommandPalette(): void
  onSelect(view: DaoViewId): void
}) {
  const live = status?.healthy === true
  const activeShell = shellViewFor(activeView)

  return (
    <aside className="workspace-sidebar" aria-label="Dao 功能导航">
      <div className="brand-lockup">
        <DaoMark />
        <span>
          <strong>
            dao<span>flow</span>
          </strong>
          <small>模型网关与协作工作台</small>
        </span>
      </div>
      <button className="sidebar-search" type="button" onClick={onOpenCommandPalette}>
        <Search size={14} aria-hidden="true" />
        <span>快速跳转</span>
        <kbd>⌘K</kbd>
      </button>
      <nav className="view-nav" aria-label="Dao 主要功能">
        <div className="view-nav-items">
          {primaryViewDefinitions(views).map((view) => (
            <SidebarItem
              key={view.id}
              view={view}
              active={activeShell === view.id}
              onSelect={onSelect}
            />
          ))}
        </div>
      </nav>
      <div className="sidebar-footer">
        <span className={`sidebar-status-dot ${live ? 'is-live' : ''}`} aria-hidden="true" />
        <span>{live ? '本地运行时已连接' : '等待本地运行时'}</span>
      </div>
    </aside>
  )
}

function SidebarItem({
  view,
  active,
  onSelect
}: {
  view: DaoViewDefinition
  active: boolean
  onSelect(view: DaoViewId): void
}) {
  const Icon = icons[view.id]
  return (
    <button
      className="view-nav-item"
      type="button"
      aria-label={view.label}
      aria-current={active ? 'page' : undefined}
      onClick={() => onSelect(view.id)}
    >
      <Icon size={16} strokeWidth={1.8} aria-hidden="true" />
      <span>{view.label}</span>
      {view.id === 'hud' && <span className="view-nav-live">LIVE</span>}
    </button>
  )
}
