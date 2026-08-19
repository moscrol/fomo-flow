import type { PropsWithChildren } from 'react'

import { SectionShellNav, type SectionShellItem } from '@/components/SectionShellNav'
import type { DaoViewId } from '@/lib/views'

const TRAFFIC_ITEMS: SectionShellItem[] = [
  { id: 'hud', label: '最近请求' },
  { id: 'overview', label: '现在是否正常' },
  { id: 'operations', label: '运行健康' },
  { id: 'decisions', label: '为什么这样走' },
  { id: 'observability', label: '问题记录' }
]

export function TrafficControlShell({
  activeView,
  onNavigate,
  children
}: PropsWithChildren<{
  activeView: DaoViewId
  onNavigate(view: DaoViewId): void
}>) {
  return (
    <div className="section-shell-stack">
      <SectionShellNav
        label="流量观测分区"
        activeView={activeView}
        items={TRAFFIC_ITEMS}
        onSelect={onNavigate}
      />
      {children}
    </div>
  )
}
