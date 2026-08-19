import type { DaoViewDefinition } from '@/lib/views'

const messages: Record<string, string> = {
  providers: '渠道组件将通过已有的本地控制面读取和编辑 Provider，不把配置文件或密钥交给渲染器。',
  routes: '路由组件将呈现官方模型、上游模型、健康状态与故障转移顺序。',
  revproxy: '反代组件将呈现标准本地端点、协议状态与可复制的连接信息。',
  observability: '观测组件将呈现经过脱敏的告警、请求链路和配置历史。',
  operations: '运行健康组件将呈现本机运行时、观测源、渠道、会话和 Taskboard 健康。',
  connectors: '连接器默认关闭；将来每次接入都会明确展示目标、备份、确认与恢复操作。'
}

export function ViewPlaceholder({ view }: { view: DaoViewDefinition }) {
  return (
    <div className="view-empty">
      <p className="workspace-kicker">{view.eyebrow}</p>
      <strong>{view.label}</strong>
      <span>{messages[view.id] ?? view.description}</span>
    </div>
  )
}
