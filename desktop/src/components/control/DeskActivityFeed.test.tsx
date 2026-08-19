// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { DeskEvent } from '@/components/work/deskEventModel'
import { DeskActivityFeed } from './DeskActivityFeed'

function event(overrides: Partial<DeskEvent>): DeskEvent {
  return {
    key: 'event-safe',
    at: 9_000,
    kind: 'progress',
    state: 'success',
    actor: 'Devin',
    verb: '正在处理',
    object: '缓存观测',
    outcome: '测试通过',
    detail: '已完成 2 / 2 项',
    importance: 'normal',
    source: 'session',
    evidence: { provider: 'cccc' },
    ...overrides
  }
}

afterEach(cleanup)

describe('DeskActivityFeed', () => {
  it('shows outcome-first events, filters attention, and reveals only safe evidence', async () => {
    const user = userEvent.setup()
    const onOpenDecisions = vi.fn()
    render(
      <DeskActivityFeed
        events={[
          event({}),
          event({
            key: 'event-approval',
            kind: 'approval',
            state: 'warning',
            actor: '路由观察',
            verb: '请求确认',
            object: '缓存下降',
            outcome: '需要你确认',
            importance: 'high',
            source: 'decision'
          }),
          event({
            key: 'event-quiet',
            kind: 'lifecycle',
            state: 'running',
            actor: 'FOMO FLOW',
            verb: '读取',
            object: '运行状态',
            outcome: '正常',
            importance: 'quiet'
          })
        ]}
        now={10_000}
        healthy
        onOpenDecisions={onOpenDecisions}
      />
    )

    expect(screen.getByRole('region', { name: '刚刚发生' })).toBeInTheDocument()
    expect(screen.getByText('3 条 · 最新 1 秒前')).toBeInTheDocument()
    expect(screen.getByText('Devin 正在处理 缓存观测')).toBeInTheDocument()
    expect(screen.getByText('→ 测试通过')).toBeInTheDocument()
    expect(screen.getByText('→ 需要你确认')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '需要处理' }))
    expect(screen.getByText('3 条 · 最新 1 秒前')).toBeInTheDocument()
    expect(screen.getByText('路由观察 请求确认 缓存下降')).toBeInTheDocument()
    expect(screen.queryByText('FOMO FLOW 读取 运行状态')).not.toBeInTheDocument()

    await user.click(screen.getByText('查看安全证据'))
    expect(screen.getByText(/"provider": "cccc"/)).toBeInTheDocument()
    expect(document.body.textContent).not.toContain('private-session')

    await user.click(screen.getByRole('button', { name: '打开待确认事项' }))
    expect(onOpenDecisions).toHaveBeenCalledTimes(1)
  })

  it('distinguishes a healthy quiet desk from an unavailable observation source', () => {
    const { rerender } = render(
      <DeskActivityFeed events={[]} now={10_000} healthy onOpenDecisions={undefined} />
    )
    expect(screen.getByText('观测正常；刚刚没有新的工作活动。')).toBeInTheDocument()

    rerender(<DeskActivityFeed events={[]} now={10_000} healthy={false} />)
    expect(screen.getByText('工作活动暂时无法读取，稍后将自动重试。')).toBeInTheDocument()
  })
})
