import { ArrowRight } from 'lucide-react'

import { ControlPanel, ControlView } from '@/components/control/ControlPrimitives'
import type { DaoViewId } from '@/lib/views'

const GROUPS = [
  {
    title: '渠道与优先级',
    items: [
      { id: 'providers', label: '接入渠道', detail: '添加渠道并检查可用性' },
      { id: 'routes', label: '模型路由', detail: '维护规定好的渠道顺序' },
      { id: 'customModels', label: '自定义模型', detail: '组合多渠道模型' }
    ]
  },
  {
    title: 'Agent 接入',
    items: [
      { id: 'codex', label: 'Codex 连接', detail: '选择本地 Codex 上游' },
      { id: 'connectors', label: '外部客户端', detail: '查看 IDE 与客户端接法' }
    ]
  },
  {
    title: '高级连接',
    items: [
      { id: 'revproxy', label: '本地接口', detail: '查看本机 API 地址' },
      { id: 'bridges', label: '协议兼容', detail: '连接不同接口格式' },
      { id: 'tunnel', label: '远程访问', detail: '按需管理远程连接' }
    ]
  }
] satisfies Array<{
  title: string
  items: Array<{ id: DaoViewId; label: string; detail: string }>
}>

export function SettingsControlView({ onNavigate }: { onNavigate(view: DaoViewId): void }) {
  return (
    <ControlView
      eyebrow="本地控制桌"
      title="设置"
      description="按目的找到渠道、路由和接入能力。只有你在原功能中明确保存，配置才会改变。"
    >
      <div className="settings-group-grid">
        {GROUPS.map((group) => (
          <ControlPanel key={group.title} title={group.title}>
            <div className="settings-capability-list">
              {group.items.map((item) => (
                <button
                  key={item.id}
                  className="settings-capability-card"
                  type="button"
                  onClick={() => onNavigate(item.id)}
                >
                  <span>
                    <strong>{item.label}</strong>
                    <small>{item.detail}</small>
                  </span>
                  <ArrowRight size={15} aria-hidden="true" />
                </button>
              ))}
            </div>
          </ControlPanel>
        ))}
      </div>
    </ControlView>
  )
}
