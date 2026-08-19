import type { DaoDashboardSnapshot } from '@/lib/desktopHost'

export function ObservabilityView({ snapshot }: { snapshot: DaoDashboardSnapshot }) {
  const failed = snapshot.failureProviders.reduce((sum, provider) => sum + provider.total, 0)
  return (
    <div className="detail-stack">
      <div className="metric-row">
        <article className="metric-card">
          <span>请求次数</span>
          <strong>{snapshot.usage.calls}</strong>
          <small>内存态聚合</small>
        </article>
        <article className="metric-card">
          <span>Token 总量</span>
          <strong>{snapshot.usage.total}</strong>
          <small>
            输入 {snapshot.usage.input} · 输出 {snapshot.usage.output}
          </small>
        </article>
        <article className="metric-card">
          <span>失败记录</span>
          <strong>{failed}</strong>
          <small>{snapshot.failureProviders.length} 个渠道有记录</small>
        </article>
      </div>
      <section className="data-panel">
        <div className="panel-heading">
          <div>
            <p className="workspace-kicker">OBSERVABILITY</p>
            <h2>故障摘要</h2>
          </div>
          <span className="panel-note">错误样本已隔离</span>
        </div>
        {snapshot.failureProviders.length === 0 ? (
          <p className="empty-note">当前没有失败模式记录。</p>
        ) : (
          <div className="failure-list">
            {snapshot.failureProviders.map((provider) => (
              <article className="failure-row" key={provider.name}>
                <div>
                  <strong>{provider.name}</strong>
                  <small>主要类型 · {provider.topKind ?? '未知'}</small>
                </div>
                <span className="failure-count">{provider.total}</span>
                <div className="failure-kinds">
                  {provider.kinds.map((kind) => (
                    <span className="badge" key={kind.kind}>
                      {kind.kind} · {kind.count}
                    </span>
                  ))}
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
      {snapshot.partial && (
        <p className="partial-note">
          部分控制面接口暂时不可用，以上数据是最近一次可读取的安全投影。
        </p>
      )}
    </div>
  )
}
