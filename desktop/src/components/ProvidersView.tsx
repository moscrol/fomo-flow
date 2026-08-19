import type { DaoDashboardProvider, DaoDashboardSnapshot } from '@/lib/desktopHost'

function healthLabel(provider: DaoDashboardProvider): string {
  if (provider.health.alive === true) return '已连通'
  if (provider.health.alive === false) return '异常'
  return '未探测'
}

export function ProvidersView({ snapshot }: { snapshot: DaoDashboardSnapshot }) {
  const activeCount = snapshot.providers.filter((provider) => provider.enabled).length
  const healthyCount = snapshot.providers.filter(
    (provider) => provider.health.alive === true
  ).length
  return (
    <div className="detail-stack">
      <div className="metric-row">
        <article className="metric-card">
          <span>渠道总数</span>
          <strong>{snapshot.providers.length}</strong>
          <small>{activeCount} 个启用</small>
        </article>
        <article className="metric-card">
          <span>已探活</span>
          <strong>{healthyCount}</strong>
          <small>最近一次控制面快照</small>
        </article>
        <article className="metric-card">
          <span>可用模型</span>
          <strong>{snapshot.availableModelCount}</strong>
          <small>默认目录与已见模型</small>
        </article>
      </div>
      <section className="data-panel">
        <div className="panel-heading">
          <div>
            <p className="workspace-kicker">PROVIDERS</p>
            <h2>渠道目录</h2>
          </div>
          <span className="panel-note">密钥仅在主进程内处理</span>
        </div>
        {snapshot.providers.length === 0 ? (
          <p className="empty-note">暂未发现渠道配置。</p>
        ) : (
          <div className="provider-list">
            {snapshot.providers.map((provider) => (
              <article className="provider-row" key={provider.name}>
                <div className="provider-main">
                  <span
                    className={`health-dot health-${provider.health.alive === true ? 'up' : provider.health.alive === false ? 'down' : 'idle'}`}
                    aria-hidden="true"
                  />
                  <div>
                    <strong>{provider.label}</strong>
                    <small>
                      {provider.name} · {provider.type}
                      {provider.builtin ? ' · 内置' : ''}
                    </small>
                  </div>
                </div>
                <div className="provider-meta">
                  <span>{healthLabel(provider)}</span>
                  <span>{provider.modelCount} 个模型</span>
                  <span>{provider.endpointHost ?? '未公布端点'}</span>
                </div>
                {provider.health.reason && (
                  <p className="provider-reason">{provider.health.reason}</p>
                )}
              </article>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
