// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import type { ChannelCapability } from './channelCapabilityModel'
import { ChannelCapabilityPanel } from './ChannelCapabilityPanel'

const capabilities: ChannelCapability[] = [
  {
    source: 'codex',
    label: 'Codex',
    protocol: 'unknown',
    observability: 'available',
    send: 'unavailable',
    approval: 'unavailable',
    handoff: 'available',
    reason: '已看到入口活动；当前只提供观测和人工交接，不代替入口发送或审批。',
    lastSeenAt: 100
  },
  {
    source: 'devin',
    label: 'Devin',
    protocol: 'acp',
    observability: 'available',
    send: 'available',
    approval: 'available',
    handoff: 'available',
    reason: '检测到本地 Devin ACP Host，可由 FOMO FLOW 观测并转交人工审批。',
    lastSeenAt: 200
  },
  {
    source: 'acp',
    label: 'ACP',
    protocol: 'unknown',
    observability: 'unknown',
    send: 'unknown',
    approval: 'unknown',
    handoff: 'unknown',
    reason: '尚未从本地安全观测源看到这个入口。',
    lastSeenAt: 0
  },
  {
    source: 'ide',
    label: 'IDE',
    protocol: 'unknown',
    observability: 'available',
    send: 'unavailable',
    approval: 'unavailable',
    handoff: 'available',
    reason: '已看到入口活动；当前只提供观测和人工交接，不代替入口发送或审批。',
    lastSeenAt: 300
  }
]

describe('ChannelCapabilityPanel', () => {
  it('explains source capabilities without exposing route or identity facts', () => {
    render(<ChannelCapabilityPanel capabilities={capabilities} />)

    expect(screen.getByRole('heading', { name: '入口能力' })).toBeInTheDocument()
    expect(screen.getByText('Devin')).toBeInTheDocument()
    expect(screen.getAllByText('可以').length).toBeGreaterThan(0)
    expect(screen.getAllByText('尚未观测').length).toBeGreaterThan(0)
    expect(screen.getAllByText('只读').length).toBeGreaterThan(0)
    expect(screen.getAllByText('看得到').length).toBeGreaterThan(0)
    expect(document.body.textContent).not.toContain('cccc')
    expect(document.body.textContent).not.toContain('gpt-5.6')
  })
})
