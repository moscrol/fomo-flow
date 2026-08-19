import type { PropsWithChildren } from 'react'

import { SectionShellNav, type SectionShellItem } from '@/components/SectionShellNav'
import type { DaoViewId } from '@/lib/views'

const COLLABORATION_ITEMS: SectionShellItem[] = [
  { id: 'collaboration', label: '协作总览' },
  { id: 'devinConnect', label: '添加 Agent' },
  { id: 'tasks', label: '任务与产物' }
]

export function CollaborationControlShell({
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
        label="ACP 协作分区"
        activeView={activeView}
        items={COLLABORATION_ITEMS}
        onSelect={onNavigate}
      />
      {children}
    </div>
  )
}
