// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { InterventionSummary } from '@/components/work/workItemInterventionModel'
import { WorkItemInterventionPanel } from './WorkItemInterventionPanel'

const summary: InterventionSummary = {
  advisoryOnly: true,
  message: '仅供比较，不会自动切换。',
  profile: 'coding',
  profileSource: 'advisory',
  candidates: [
    { provider: '本地', model: 'fast', score: 0.8, reason: '低延迟', advisoryOnly: true },
    { provider: '云端', model: 'steady', score: 0.7, reason: '稳定', advisoryOnly: true },
    { provider: '备用', model: 'safe', score: 0.6, reason: '备用', advisoryOnly: true }
  ]
}

afterEach(cleanup)

describe('work item intervention panel', () => {
  it('renders only projected data and delegates refresh without reading an API', async () => {
    const user = userEvent.setup()
    const onRefresh = vi.fn()
    render(
      <WorkItemInterventionPanel
        title="编译任务"
        summary={summary}
        handoff=""
        loading={false}
        status=""
        onRefresh={onRefresh}
      />
    )

    expect(screen.getByText(/本地 · fast/)).toBeInTheDocument()
    expect(screen.getByText('建议视角：编码（接口返回）')).toBeInTheDocument()
    expect(screen.getByText('仅供比较，不会自动切换。')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '重新读取建议' }))
    expect(onRefresh).toHaveBeenCalledOnce()
  })

  it('keeps candidate priority as an in-memory draft that can be reordered and reset', async () => {
    const user = userEvent.setup()
    render(
      <WorkItemInterventionPanel
        title="编译任务"
        summary={summary}
        handoff=""
        loading={false}
        status=""
        onRefresh={() => undefined}
      />
    )

    const list = screen.getByRole('list', { name: '路由建议' })
    expect(within(list).getAllByRole('listitem')[0]).toHaveTextContent('本地 · fast')
    const moveBackupUp = screen.getByRole('button', { name: '将备用 · safe上移' })
    await user.click(moveBackupUp)
    expect(within(list).getAllByRole('listitem')[1]).toHaveTextContent('备用 · safe')
    expect(moveBackupUp).toHaveFocus()
    expect(screen.getByText('草稿顺序不会自动保存。')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '重置顺序草稿' }))
    expect(within(list).getAllByRole('listitem')[0]).toHaveTextContent('本地 · fast')
  })

  it('marks a missing source as a balanced safety fallback', () => {
    render(
      <WorkItemInterventionPanel
        title="编译任务"
        summary={{ ...summary, profile: 'balanced', profileSource: 'default' }}
        handoff=""
        loading={false}
        status=""
        onRefresh={() => undefined}
      />
    )

    expect(screen.getByText('建议视角：均衡（安全默认）')).toBeInTheDocument()
  })
})
