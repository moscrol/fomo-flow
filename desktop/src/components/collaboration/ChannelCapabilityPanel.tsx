import { Check, Eye, GitPullRequestArrow, HelpCircle, Send, ShieldCheck, X } from 'lucide-react'

import type { ChannelCapability, ChannelCapabilityState } from './channelCapabilityModel'
import { ControlPanel } from '@/components/control/ControlPrimitives'

function stateLabel(state: ChannelCapabilityState): string {
  if (state === 'available') return '可以'
  if (state === 'unavailable') return '只读'
  return '尚未观测'
}

function stateClass(state: ChannelCapabilityState): string {
  return `channel-capability-state state-${state}`
}

function StateIcon({ state }: { state: ChannelCapabilityState }) {
  if (state === 'available') return <Check size={13} aria-hidden="true" />
  if (state === 'unavailable') return <X size={13} aria-hidden="true" />
  return <HelpCircle size={13} aria-hidden="true" />
}

function CapabilityCell({ label, state }: { label: string; state: ChannelCapabilityState }) {
  return (
    <span className={stateClass(state)}>
      <StateIcon state={state} />
      <span>{stateLabel(state)}</span>
      <small>{label}</small>
    </span>
  )
}

export function ChannelCapabilityPanel({ capabilities }: { capabilities: ChannelCapability[] }) {
  return (
    <ControlPanel title="入口能力" note="来源通道 · 只读观测" className="channel-capability-panel">
      <p className="channel-capability-intro">
        这里回答“FOMO FLOW 能对哪个入口做什么”。上游渠道、模型和 priority 仍在路由证据里单独查看。
      </p>
      <div className="channel-capability-list" role="list" aria-label="来源入口能力">
        {capabilities.map((capability) => (
          <article className="channel-capability-row" key={capability.source} role="listitem">
            <div className="channel-capability-source">
              <strong>{capability.label}</strong>
              <small>{capability.protocol === 'acp' ? 'ACP 可协作' : '协议未确认'}</small>
            </div>
            <div className="channel-capability-cells">
              <CapabilityCell label="看得到" state={capability.observability} />
              <CapabilityCell label="发送" state={capability.send} />
              <CapabilityCell label="审批" state={capability.approval} />
              <CapabilityCell label="交接" state={capability.handoff} />
            </div>
            <p className="channel-capability-reason">{capability.reason}</p>
          </article>
        ))}
      </div>
      <div className="channel-capability-legend" aria-label="能力说明">
        <span>
          <Eye size={13} aria-hidden="true" /> 看得到 = 已有安全观测
        </span>
        <span>
          <Send size={13} aria-hidden="true" /> 发送 = FOMO FLOW 可代入口发消息
        </span>
        <span>
          <ShieldCheck size={13} aria-hidden="true" /> 审批 = FOMO FLOW 可转交审批
        </span>
        <span>
          <GitPullRequestArrow size={13} aria-hidden="true" /> 交接 = 可生成安全交接摘要
        </span>
      </div>
    </ControlPanel>
  )
}
