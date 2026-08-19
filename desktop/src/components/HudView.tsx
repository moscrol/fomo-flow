import type { DaoDesktopStatus } from '@/lib/desktopHost'

export function HudView({ status }: { status: DaoDesktopStatus | null }) {
  if (!status?.healthy || !status.url) {
    return (
      <div className="view-empty">
        <strong>实时 HUD 尚未连接</strong>
        <span>本地运行时就绪后会在这里加载 HUD。</span>
      </div>
    )
  }
  return (
    <iframe
      className="hud-frame"
      title="Dao 实时 HUD"
      src={new URL('/hud', status.url).toString()}
      // The existing HUD fetches its event stream from the loopback runtime;
      // retaining its real loopback origin keeps snapshot/event APIs functional
      // while the sandbox still blocks forms, popups, and top-level navigation.
      sandbox="allow-scripts allow-same-origin"
      referrerPolicy="no-referrer"
    />
  )
}
