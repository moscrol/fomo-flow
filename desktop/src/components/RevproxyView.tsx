import type { DaoDashboardSnapshot } from '@/lib/desktopHost'

export function RevproxyView({ snapshot }: { snapshot: DaoDashboardSnapshot }) {
  const endpoint = snapshot.revproxy.port
    ? `http://127.0.0.1:${snapshot.revproxy.port}/v1`
    : '未启动'
  const protocols = ['OpenAI Chat', 'OpenAI Responses', 'Anthropic', 'Gemini']
  return (
    <div className="detail-stack">
      <section className="hero-panel">
        <div>
          <p className="workspace-kicker">MODEL REVERSE PROXY</p>
          <h2>{snapshot.revproxy.enabled ? '本地反代已启用' : '本地反代未启用'}</h2>
          <p>{endpoint}</p>
        </div>
        <span className={`state-pill ${snapshot.revproxy.enabled ? 'state-good' : 'state-muted'}`}>
          {snapshot.revproxy.enabled ? 'RUNNING' : 'OFF'}
        </span>
      </section>
      <div className="metric-row">
        <article className="metric-card">
          <span>可反代模型</span>
          <strong>{snapshot.revproxy.modelCount}</strong>
          <small>来自当前路由与模型目录</small>
        </article>
        <article className="metric-card">
          <span>本地鉴权</span>
          <strong>{snapshot.revproxy.hasKey ? '已配置' : '本机放行'}</strong>
          <small>密钥值不会进入 React</small>
        </article>
        <article className="metric-card">
          <span>双路互补</span>
          <strong>{snapshot.revproxy.dualPath ? '开启' : '关闭'}</strong>
          <small>{snapshot.revproxy.exposeLan ? '允许局域网标记' : '仅本机'}</small>
        </article>
      </div>
      <section className="data-panel">
        <div className="panel-heading">
          <div>
            <p className="workspace-kicker">PROTOCOLS</p>
            <h2>兼容协议</h2>
          </div>
          <span className="panel-note">标准 /v1 端点</span>
        </div>
        <div className="protocol-grid">
          {protocols.map((protocol) => (
            <span className="protocol-chip" key={protocol}>
              {protocol}
              <b>可用</b>
            </span>
          ))}
        </div>
        <p className="panel-footnote">
          提示词隔离：{snapshot.revproxy.isolatePrompt ? '开启' : '关闭'} · 反向映射：
          {snapshot.revproxy.applyInvert ? '开启' : '关闭'}
        </p>
      </section>
    </div>
  )
}
