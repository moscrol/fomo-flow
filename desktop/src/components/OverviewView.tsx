import { ArrowRight, ArrowUpRight, Braces, Route, ShieldCheck } from 'lucide-react'

import type { DaoDashboardSnapshot, DaoDesktopStatus } from '@/lib/desktopHost'
import type { DaoViewId } from '@/lib/views'

export function OverviewView({
  status,
  snapshot,
  onRetry,
  onNavigate
}: {
  status: DaoDesktopStatus | null
  snapshot: DaoDashboardSnapshot
  onRetry(): void
  onNavigate(view: DaoViewId): void
}) {
  const healthy = !!status?.healthy
  const port = status?.port ?? '—'
  const healthyProviders = snapshot.providers.filter(
    (provider) => provider.health.alive === true
  ).length
  const attentionCount = snapshot.failureProviders.reduce(
    (total, provider) => total + provider.total,
    0
  )
  const overallLabel = !healthy ? '需要处理' : attentionCount > 0 ? '有需要注意的地方' : '整体正常'
  const overallDetail = !healthy
    ? '本地服务没有连接，先重试连接，其他页面暂时不会有新数据。'
    : attentionCount > 0
      ? `${attentionCount} 个渠道有失败记录，先查看问题与数据。`
      : '本地服务、渠道和路由目前没有明显异常。'
  return (
    <div className="overview-stack">
      <section className="overview-beginner-panel" aria-label="新手入口">
        <div className="overview-beginner-heading">
          <div>
            <p className="workspace-kicker">从这里开始</p>
            <h2>你现在想做什么？</h2>
            <p>不用先理解术语，直接选择下一步。</p>
          </div>
          <div className={`overview-health-summary ${healthy ? 'is-good' : 'is-bad'}`}>
            <span className="overview-health-dot" aria-hidden="true" />
            <div>
              <strong>{overallLabel}</strong>
              <span>{overallDetail}</span>
            </div>
          </div>
        </div>
        <div className="overview-task-grid">
          <OverviewTaskCard
            eyebrow="先看一眼"
            title="现在正常吗？"
            description="查看服务、渠道和最近请求有没有问题。"
            action="打开运行情况"
            onClick={() => onNavigate('hud')}
          />
          <OverviewTaskCard
            eyebrow="想改配置"
            title="我要接入渠道"
            description="添加 API、检查可用性，并查看有哪些模型。"
            action="管理渠道"
            onClick={() => onNavigate('providers')}
          />
          <OverviewTaskCard
            eyebrow="想决定走哪家"
            title="我要决定模型走哪家"
            description="把 Devin、Codex 的模型连接到你的上游渠道。"
            action="调整模型怎么走"
            onClick={() => onNavigate('routes')}
          />
          <OverviewTaskCard
            eyebrow="正在协作"
            title="我要看任务和会话"
            description="查看 ACP、Devin、Codex 的进度、异常和交接。"
            action="打开协作会话"
            onClick={() => onNavigate('collaboration')}
          />
        </div>
      </section>
      <div className="overview-grid">
        <article className="status-card status-card-primary">
          <p>本地运行时</p>
          <strong>{healthy ? '运行中' : '需要重试'}</strong>
          <span>
            {healthy
              ? `仅监听 127.0.0.1:${port}`
              : '桌面主进程会保留诊断状态，不暴露密钥或原始错误。'}
          </span>
          {!healthy && (
            <button type="button" className="primary-action" onClick={onRetry}>
              重试连接
            </button>
          )}
        </article>
        <article className="status-card">
          <p>本地端点</p>
          <strong>{healthy ? `/v1 · :${port}` : '未就绪'}</strong>
          <span>OpenAI、Responses、Anthropic 与 Gemini 兼容接口保持可用。</span>
        </article>
        <article className="status-card">
          <p>渠道健康</p>
          <strong>
            {healthyProviders}/{snapshot.providers.length || '—'}
          </strong>
          <span>数据来自已脱敏的本地控制面快照。</span>
        </article>
        <article className="status-card">
          <p>路由与反代</p>
          <strong>
            {snapshot.routes.length} · {snapshot.revproxy.enabled ? '已启用' : '未启用'}
          </strong>
          <span>{snapshot.availableModelCount} 个可见模型，配置动作仍由受控组件完成。</span>
        </article>
      </div>
      <div className="overview-detail-grid">
        <section className="data-panel overview-routes-panel">
          <div className="panel-heading">
            <div>
              <p className="workspace-kicker">ACTIVE MAP</p>
              <h2>正在生效的模型路由</h2>
            </div>
            <Route size={19} aria-hidden="true" />
          </div>
          {snapshot.routes.length === 0 ? (
            <p className="empty-note">等待路由器提供首个模型映射。</p>
          ) : (
            <div className="overview-route-list">
              {snapshot.routes.slice(0, 5).map((route) => (
                <div className="overview-route-row" key={route.uid}>
                  <div>
                    <strong>{route.uid}</strong>
                    <small>
                      {route.provider ?? '自动选择'}
                      {route.model ? ` / ${route.model}` : ''}
                    </small>
                  </div>
                  <ArrowUpRight size={15} aria-hidden="true" />
                </div>
              ))}
            </div>
          )}
        </section>
        <section className="overview-side-stack">
          <article className="overview-safety-card">
            <ShieldCheck size={19} aria-hidden="true" />
            <div>
              <strong>受控本地边界</strong>
              <span>配置、密钥和完整错误不进入渲染进程。</span>
            </div>
          </article>
          <article className="overview-api-card">
            <Braces size={19} aria-hidden="true" />
            <div>
              <p>本次内存请求</p>
              <strong>
                {snapshot.usage.calls} 次 · {snapshot.usage.total} tokens
              </strong>
            </div>
          </article>
        </section>
      </div>
    </div>
  )
}

function OverviewTaskCard({
  eyebrow,
  title,
  description,
  action,
  onClick
}: {
  eyebrow: string
  title: string
  description: string
  action: string
  onClick(): void
}) {
  return (
    <article className="overview-task-card">
      <p className="workspace-kicker">{eyebrow}</p>
      <h3>{title}</h3>
      <p>{description}</p>
      <button type="button" className="overview-task-action" onClick={onClick}>
        {action}
        <ArrowRight size={14} aria-hidden="true" />
      </button>
    </article>
  )
}
