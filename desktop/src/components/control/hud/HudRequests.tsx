import {
  formatCompact,
  formatLatency,
  formatPercent,
  formatTime,
  requestCacheStatus,
  requestState
} from './hudFormatters'
import { HudPanelHeading } from './HudPanelHeading'
import type { HudRequest } from './hudProjection'

export type HudRequestFallback = {
  at: string
  source: string
  provider: string
  model: string
  state: string
}

export function HudRequests({
  requests,
  sourceFilter,
  fallbackTraces = []
}: {
  requests: HudRequest[]
  sourceFilter: string
  fallbackTraces?: HudRequestFallback[]
}) {
  const visibleRequests = requests.filter(
    (request) =>
      sourceFilter === 'all' || (request.source === 'codex' ? 'codex' : 'devin') === sourceFilter
  )
  return (
    <section className="hud-panel hud-requests-panel" aria-label="最近请求">
      <HudPanelHeading
        eyebrow="RECENT CACHE SAMPLES"
        title="最近请求"
        aside={
          <div className="hud-request-legend" aria-label="图例">
            <span className="is-read">缓存读</span>
            <span className="is-write">缓存写</span>
            <span className="is-miss">未命中</span>
          </div>
        }
      />
      {visibleRequests.length === 0 ? (
        fallbackTraces.length > 0 ? (
          <div className="hud-request-fallback">
            <p className="hud-empty">
              已发生 {fallbackTraces.length} 条请求，但缓存 token 尚未回填；以下是请求链路事实。
            </p>
            <div className="hud-request-fallback-list">
              {fallbackTraces.map((trace, index) => (
                <div className="hud-request-fallback-row" key={`${trace.at}-${index}`}>
                  <time>{trace.at}</time>
                  <span>{trace.source}</span>
                  <strong>{trace.provider}</strong>
                  <small>{trace.model}</small>
                  <span>{trace.state}</span>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <p className="hud-empty">等待首个缓存观测样本</p>
        )
      ) : (
        <div className="hud-table-scroll">
          <table className="hud-request-table">
            <thead>
              <tr>
                <th>时间</th>
                <th>来源</th>
                <th>渠道 / 模型</th>
                <th>策略</th>
                <th>缓存 / 会话亲和</th>
                <th>命中</th>
                <th>读取</th>
                <th>写入</th>
                <th>前缀连续性</th>
                <th>TTFT</th>
                <th>上游首字</th>
                <th>重试开销</th>
                <th>状态</th>
              </tr>
            </thead>
            <tbody>
              {visibleRequests.map((request) => (
                <HudRequestRow key={request.id} request={request} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

function HudRequestRow({ request }: { request: HudRequest }) {
  const cacheStatus = requestCacheStatus(request)
  const state = requestState(request)
  const measured = cacheStatus !== 'unknown'
  const cachedTone = measured && request.cached > 0 ? 'is-read' : 'is-miss'
  const cacheWriteTone = measured && request.cacheWrite > 0 ? 'is-write' : 'is-miss'
  return (
    <tr>
      <td>{formatTime(request.at)}</td>
      <td className="hud-request-source">{request.source.toUpperCase()}</td>
      <td>
        <div className="hud-request-channel">
          <strong>{request.provider}</strong>
          <small>{request.model}</small>
        </div>
      </td>
      <td>{`${request.cacheMode} · ${request.cacheTtl}`}</td>
      <td className="hud-request-cache" title={request.cacheName}>
        {request.cacheName}
      </td>
      <td className={cachedTone}>{measured ? formatPercent(request.hitRate) : '—'}</td>
      <td className={cachedTone}>{measured ? formatCompact(request.cached) : '—'}</td>
      <td className={cacheWriteTone}>{measured ? formatCompact(request.cacheWrite) : '—'}</td>
      <td>
        <PrefixContinuity request={request} />
      </td>
      <td>{request.ttftObserved ? formatLatency(request.ttftMs) : '—'}</td>
      <td>{formatLatency(request.upstreamSemanticMs)}</td>
      <td className={request.retryOverheadMs && request.retryOverheadMs > 0 ? 'is-retry' : ''}>
        {formatLatency(request.retryOverheadMs)}
      </td>
      <td>
        <span className={`hud-request-state hud-tone-${state.tone}`}>{state.label}</span>
      </td>
    </tr>
  )
}

const prefixCopy: Record<string, { label: string; detail: string }> = {
  'append-only': { label: '仅追加', detail: '前缀连续，可复用' },
  rewritten: { label: '已重排', detail: '上下文被重排，上游无法复用前缀' },
  'family-changed': { label: '新缓存族', detail: '缓存族刚切换，需要重新建立缓存' },
  cold: { label: '首次请求', detail: '正在建立缓存' },
  unknown: { label: '待观测', detail: '还没有足够的前缀证据' }
}

function PrefixContinuity({ request }: { request: HudRequest }) {
  const copy = prefixCopy[request.prefixState] || prefixCopy.unknown
  const observed = request.prefixState !== 'unknown'
  const facts = [
    observed && request.stablePrefixChars > 2
      ? `${formatCompact(request.stablePrefixChars)} ch`
      : '',
    observed && request.prefixGeneration > 0 ? `第 ${request.prefixGeneration} 代` : ''
  ].filter(Boolean)

  return (
    <div className="hud-prefix-continuity">
      <strong>{copy.label}</strong>
      <small>{copy.detail}</small>
      {facts.length > 0 && <span>{facts.join(' · ')}</span>}
    </div>
  )
}
