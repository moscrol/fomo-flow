// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { TaskboardSnapshot } from '@/lib/desktopHost'
import { TaskboardWorkPanel } from './TaskboardWorkPanel'

const NOW = Date.UTC(2026, 7, 10, 5, 0, 0)

afterEach(cleanup)

describe('Taskboard work panel', () => {
  it('renders safe plan and review items in supplied order', () => {
    const snapshot: TaskboardSnapshot = {
      state: 'connected',
      writable: false,
      message: '已连接；加入任务板需要从当前 Codex 任务发起。',
      items: [
        {
          identifier: 'DAOFLOW-2',
          title: '阻塞事项',
          status: 'blocked',
          priority: 'high',
          updatedAt: NOW - 1_000
        },
        {
          identifier: 'DAOFLOW-1',
          title: '进行事项',
          status: 'in_progress',
          priority: 'urgent',
          updatedAt: NOW - 2_000
        },
        {
          identifier: 'DAOFLOW-3',
          title: '待验收事项',
          status: 'in_review',
          priority: 'medium',
          updatedAt: NOW - 3_000
        }
      ]
    }

    render(
      <TaskboardWorkPanel
        snapshot={snapshot}
        loading={false}
        now={NOW}
        onRefresh={() => undefined}
        onConnect={() => undefined}
      />
    )

    expect(screen.getByRole('heading', { name: '计划与验收' })).toBeInTheDocument()
    expect(screen.getAllByRole('article').map((node) => node.textContent)).toEqual([
      expect.stringContaining('阻塞事项'),
      expect.stringContaining('进行事项'),
      expect.stringContaining('待验收事项')
    ])
    expect(screen.getByText('阻塞')).toBeInTheDocument()
    expect(screen.getByText('进行中')).toBeInTheDocument()
    expect(screen.getByText('待验收')).toBeInTheDocument()
    expect(screen.queryByText(/private-task|threadId|\/Users\//)).not.toBeInTheDocument()
  })

  it('shows a plain empty state while connected', () => {
    render(
      <TaskboardWorkPanel
        snapshot={{
          state: 'connected',
          writable: true,
          message: '已连接本地 Taskboard。',
          items: []
        }}
        loading={false}
        now={NOW}
        onRefresh={() => undefined}
        onConnect={() => undefined}
      />
    )

    expect(screen.getByText('当前仓库没有进行中、阻塞或待验收事项。')).toBeInTheDocument()
  })

  it('keeps offline and unmapped recovery explicit', () => {
    const onConnect = vi.fn()
    const onRefresh = vi.fn()
    const { rerender } = render(
      <TaskboardWorkPanel
        snapshot={{
          state: 'disconnected',
          writable: false,
          message: '本地 Taskboard 暂时不可用，实时工作不受影响。',
          items: []
        }}
        loading={false}
        now={NOW}
        onRefresh={onRefresh}
        onConnect={onConnect}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: '连接本地 Taskboard' }))
    fireEvent.click(screen.getByRole('button', { name: '重试任务板' }))
    expect(onConnect).toHaveBeenCalledTimes(1)
    expect(onRefresh).toHaveBeenCalledTimes(1)

    rerender(
      <TaskboardWorkPanel
        snapshot={{
          state: 'unmapped',
          writable: false,
          message: '当前仓库尚未映射到本地 Taskboard 项目。',
          items: []
        }}
        loading={false}
        now={NOW}
        onRefresh={onRefresh}
        onConnect={onConnect}
      />
    )
    expect(screen.getByText('当前仓库尚未映射到本地 Taskboard 项目。')).toBeInTheDocument()
  })
})
