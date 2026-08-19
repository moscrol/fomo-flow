import { lazy, Suspense, useEffect, useMemo, useState } from 'react'

import { CommandPalette } from '@/components/CommandPalette'
import { OverviewView } from '@/components/OverviewView'
import { SectionShellNav, type SectionShellItem } from '@/components/SectionShellNav'
import { Sidebar } from '@/components/Sidebar'
import type { DaoTheme } from '@/components/ThemeToggle'
import { ViewPlaceholder } from '@/components/ViewPlaceholder'
import { WorkspaceShell } from '@/components/WorkspaceShell'
import {
  desktopHost,
  emptyDaoDashboardSnapshot,
  type DaoDashboardSnapshot,
  type DaoDesktopStatus
} from '@/lib/desktopHost'
import { DAO_VIEW_DEFINITIONS, isDaoViewId, shellViewFor, type DaoViewId } from '@/lib/views'
import { LoadingState } from '@/components/control/ControlPrimitives'
import { CollaborationControlShell } from '@/components/control/CollaborationControlShell'
import { TrafficControlShell } from '@/components/control/TrafficControlShell'
import type { WorkItem } from '@/components/work/workItemModel'

const HudControlView = lazy(() =>
  import('@/components/control/HudControlView').then((module) => ({
    default: module.HudControlView
  }))
)
const AcpWorkbenchControlView = lazy(() =>
  import('@/components/control/AcpWorkbenchControlView').then((module) => ({
    default: module.AcpWorkbenchControlView
  }))
)
const DevinConnectControlView = lazy(() =>
  import('@/components/control/DevinConnectControlView').then((module) => ({
    default: module.DevinConnectControlView
  }))
)
const TaskCenterControlView = lazy(() =>
  import('@/components/control/TaskCenterControlView').then((module) => ({
    default: module.TaskCenterControlView
  }))
)
const ProvidersControlView = lazy(() =>
  import('@/components/control/ProvidersControlView').then((module) => ({
    default: module.ProvidersControlView
  }))
)
const RoutesControlView = lazy(() =>
  import('@/components/control/RoutesControlView').then((module) => ({
    default: module.RoutesControlView
  }))
)
const RevproxyControlView = lazy(() =>
  import('@/components/control/RevproxyControlView').then((module) => ({
    default: module.RevproxyControlView
  }))
)
const TunnelControlView = lazy(() =>
  import('@/components/control/TunnelControlView').then((module) => ({
    default: module.TunnelControlView
  }))
)
const BridgesControlView = lazy(() =>
  import('@/components/control/BridgesControlView').then((module) => ({
    default: module.BridgesControlView
  }))
)
const CustomModelsControlView = lazy(() =>
  import('@/components/control/CustomModelsControlView').then((module) => ({
    default: module.CustomModelsControlView
  }))
)
const CodexControlView = lazy(() =>
  import('@/components/control/CodexControlView').then((module) => ({
    default: module.CodexControlView
  }))
)
const ObservabilityControlView = lazy(() =>
  import('@/components/control/ObservabilityControlView').then((module) => ({
    default: module.ObservabilityControlView
  }))
)
const OperationsHealthControlView = lazy(() =>
  import('@/components/control/OperationsHealthControlView').then((module) => ({
    default: module.OperationsHealthControlView
  }))
)
const ConnectorsControlView = lazy(() =>
  import('@/components/control/ConnectorsControlView').then((module) => ({
    default: module.ConnectorsControlView
  }))
)
const CurrentWorkControlView = lazy(() =>
  import('@/components/control/CurrentWorkControlView').then((module) => ({
    default: module.CurrentWorkControlView
  }))
)
const DecisionCenterControlView = lazy(() =>
  import('@/components/control/DecisionCenterControlView').then((module) => ({
    default: module.DecisionCenterControlView
  }))
)
const SettingsControlView = lazy(() =>
  import('@/components/control/SettingsControlView').then((module) => ({
    default: module.SettingsControlView
  }))
)

const SETTINGS_NAV: SectionShellItem[] = [
  { id: 'settings', label: '设置首页' },
  { id: 'providers', label: '渠道' },
  { id: 'routes', label: '路由' },
  { id: 'customModels', label: '自定义模型' },
  { id: 'codex', label: 'Codex' },
  { id: 'connectors', label: '外部接入' },
  { id: 'revproxy', label: '本地接口' },
  { id: 'bridges', label: '协议兼容' },
  { id: 'tunnel', label: '远程访问' }
]

export function App({ initialView = 'work' }: { initialView?: DaoViewId }) {
  const [activeView, setActiveView] = useState<DaoViewId>(() => {
    try {
      const savedView = window.localStorage.getItem('dao.desktop.last-view')
      return savedView && isDaoViewId(savedView) ? savedView : initialView
    } catch {
      return initialView
    }
  })
  const [commandOpen, setCommandOpen] = useState(false)
  const [status, setStatus] = useState<DaoDesktopStatus | null>(null)
  const [snapshot, setSnapshot] = useState<DaoDashboardSnapshot>(emptyDaoDashboardSnapshot)
  const [workSelection, setWorkSelection] = useState<{ sessionId: string; taskId: string }>({
    sessionId: '',
    taskId: ''
  })
  const [theme, setTheme] = useState<DaoTheme>(() => {
    try {
      const savedTheme = window.localStorage.getItem('dao.desktop.theme')
      return savedTheme === 'paper' || savedTheme === 'ink' || savedTheme === 'night'
        ? savedTheme
        : 'paper'
    } catch {
      return 'paper'
    }
  })
  const activeDefinition = useMemo(
    () => DAO_VIEW_DEFINITIONS.find((view) => view.id === activeView) ?? DAO_VIEW_DEFINITIONS[0],
    [activeView]
  )
  const activeShell = shellViewFor(activeView)

  async function refreshStatus(retry = false): Promise<void> {
    const host = desktopHost()
    try {
      const nextStatus = retry ? await host.retryRuntime() : await host.getRuntimeStatus()
      setStatus(nextStatus)
      if (nextStatus.healthy) setSnapshot(await host.getDashboardSnapshot())
      else setSnapshot({ ...emptyDaoDashboardSnapshot })
    } catch {
      setStatus({
        healthy: false,
        running: false,
        port: null,
        url: null,
        profile: 'desktop',
        imported: { config: false, revproxy: false },
        error: '桌面运行时暂不可用'
      })
      setSnapshot({ ...emptyDaoDashboardSnapshot })
    }
  }

  useEffect(() => {
    void refreshStatus()
    const timer = window.setInterval(() => void refreshStatus(), 5_000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    try {
      window.localStorage.setItem('dao.desktop.theme', theme)
    } catch {
      void 0
    }
  }, [theme])

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === 'k') {
        event.preventDefault()
        setCommandOpen(true)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  function selectView(view: DaoViewId): void {
    if (!isDaoViewId(view)) return
    setActiveView(view)
    setCommandOpen(false)
    try {
      window.localStorage.setItem('dao.desktop.last-view', view)
    } catch {
      void 0
    }
  }

  function openWorkItem(item: WorkItem): void {
    setWorkSelection((current) => ({
      sessionId: item.kind === 'session' ? item.target.id : current.sessionId,
      taskId: item.kind === 'task' ? item.target.id : current.taskId
    }))
    selectView(item.target.view)
  }

  let content = <ViewPlaceholder view={activeDefinition} />
  if (activeView === 'work')
    content = <CurrentWorkControlView onOpenItem={openWorkItem} onNavigate={selectView} />
  if (activeView === 'settings') content = <SettingsControlView onNavigate={selectView} />
  if (activeView === 'decisions') content = <DecisionCenterControlView onNavigate={selectView} />
  if (activeView === 'overview')
    content = (
      <OverviewView
        status={status}
        snapshot={snapshot}
        onRetry={() => void refreshStatus(true)}
        onNavigate={selectView}
      />
    )
  if (activeView === 'hud') content = <HudControlView />
  if (activeView === 'devinConnect') content = <DevinConnectControlView />
  if (activeView === 'collaboration')
    content = (
      <AcpWorkbenchControlView
        selectedSessionId={workSelection.sessionId || undefined}
        onNavigate={selectView}
      />
    )
  if (activeView === 'tasks')
    content = <TaskCenterControlView selectedTaskId={workSelection.taskId || undefined} />
  if (activeView === 'providers') content = <ProvidersControlView />
  if (activeView === 'routes') content = <RoutesControlView />
  if (activeView === 'revproxy') content = <RevproxyControlView />
  if (activeView === 'tunnel') content = <TunnelControlView />
  if (activeView === 'bridges') content = <BridgesControlView />
  if (activeView === 'customModels') content = <CustomModelsControlView />
  if (activeView === 'codex') content = <CodexControlView />
  if (activeView === 'observability') content = <ObservabilityControlView onNavigate={selectView} />
  if (activeView === 'operations') content = <OperationsHealthControlView onNavigate={selectView} />
  if (activeView === 'connectors') content = <ConnectorsControlView />

  const suspendedContent = (
    <Suspense fallback={<LoadingState label="正在加载独立功能组件…" />}>{content}</Suspense>
  )

  if (activeShell === 'settings') {
    content = (
      <div className="section-shell-stack">
        <SectionShellNav
          label="设置分区"
          activeView={activeView}
          items={SETTINGS_NAV}
          onSelect={selectView}
        />
        {suspendedContent}
      </div>
    )
  }
  if (activeShell === 'hud') {
    content = (
      <TrafficControlShell activeView={activeView} onNavigate={selectView}>
        {suspendedContent}
      </TrafficControlShell>
    )
  }
  if (activeShell === 'collaboration') {
    content = (
      <CollaborationControlShell activeView={activeView} onNavigate={selectView}>
        {suspendedContent}
      </CollaborationControlShell>
    )
  }

  return (
    <>
      <WorkspaceShell
        sidebar={
          <Sidebar
            activeView={activeView}
            views={DAO_VIEW_DEFINITIONS}
            status={status}
            onOpenCommandPalette={() => setCommandOpen(true)}
            onSelect={selectView}
          />
        }
        title={activeDefinition.label}
        description={activeDefinition.description}
        status={status}
        theme={theme}
        onThemeChange={setTheme}
        onOpenCommandPalette={() => setCommandOpen(true)}
      >
        {activeShell === 'work' ? suspendedContent : content}
      </WorkspaceShell>
      <CommandPalette
        open={commandOpen}
        views={DAO_VIEW_DEFINITIONS}
        onSelect={selectView}
        onClose={() => setCommandOpen(false)}
      />
    </>
  )
}
