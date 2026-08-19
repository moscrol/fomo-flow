import type { DaoDashboardSnapshot } from '@/lib/desktopHost'

export function RoutesView({ snapshot }: { snapshot: DaoDashboardSnapshot }) {
  return (
    <div className="detail-stack">
      <div className="metric-row">
        <article className="metric-card">
          <span>路由数</span>
          <strong>{snapshot.routes.length}</strong>
          <small>{snapshot.routerReady ? '路由器已就绪' : '路由器未就绪'}</small>
        </article>
        <article className="metric-card">
          <span>自动回退</span>
          <strong>{snapshot.routes.reduce((sum, route) => sum + route.fallbackCount, 0)}</strong>
          <small>备用渠道顺序</small>
        </article>
        <article className="metric-card">
          <span>档位延伸</span>
          <strong>{snapshot.familyTierExtend ? '开启' : '关闭'}</strong>
          <small>按家族继承档位</small>
        </article>
      </div>
      <section className="data-panel">
        <div className="panel-heading">
          <div>
            <p className="workspace-kicker">ROUTES</p>
            <h2>模型路由</h2>
          </div>
          <span className="panel-note">只读安全投影</span>
        </div>
        {snapshot.routes.length === 0 ? (
          <p className="empty-note">暂未配置模型路由。</p>
        ) : (
          <div className="route-list">
            {snapshot.routes.map((route) => (
              <article className="route-row" key={route.uid}>
                <div>
                  <strong>{route.uid}</strong>
                  <small>{route.model ? `上游模型 · ${route.model}` : '沿用渠道默认模型'}</small>
                </div>
                <div className="route-badges">
                  <span className={route.enabled ? 'badge badge-good' : 'badge'}>
                    {route.enabled ? '启用' : '停用'}
                  </span>
                  <span className="badge">{route.provider ?? '自动选择'}</span>
                  {route.fallbackCount > 0 && (
                    <span className="badge">+{route.fallbackCount} 回退</span>
                  )}
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
