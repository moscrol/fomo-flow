// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { HudTasks } from './HudTasks'
import { projectHudTaskDesk, type HudTask } from './hudProjection'

afterEach(cleanup)

function task(status: string, overrides: Partial<HudTask> = {}): HudTask {
  return {
    id: `${status}-safe-id`,
    source: 'codex',
    taskType: `${status} task`,
    status,
    phase: '执行中',
    progress: '正在处理',
    freshnessMs: 2_000,
    attemptCount: 2,
    fallbackCount: 0,
    result: { status: '', errorCategory: '' },
    ...overrides
  }
}

describe('HUD long-running task facts', () => {
  it('explains what is observed instead of presenting an opaque reliability score', () => {
    render(
      <HudTasks
        tasks={[
          task('running'),
          task('failed', {
            fallbackCount: 1,
            result: { status: 'failed', errorCategory: 'timeout' }
          }),
          task('succeeded', { result: { status: 'succeeded', errorCategory: '' } })
        ]}
      />
    )

    expect(screen.getByRole('heading', { name: '长任务运行情况' })).toBeInTheDocument()
    expect(
      screen.getByText('这里只显示最近 5 分钟有心跳的 Dao 登记长任务，不是聊天会话。')
    ).toBeInTheDocument()
    expect(screen.getByText('运行中 1')).toBeInTheDocument()
    expect(screen.getByText('需要处理 1')).toBeInTheDocument()
    expect(screen.getByText('已结束 1')).toBeInTheDocument()
    expect(screen.getByText('备用渠道 1 次')).toBeInTheDocument()
    expect(screen.queryByText('任务可靠性')).not.toBeInTheDocument()
  })

  it('keeps stale task records out of the live summary and task cards', () => {
    const staleFailure = task('failed', {
      taskType: '31 hours old failure',
      freshnessMs: 5 * 60_000 + 1,
      result: { status: 'failed', errorCategory: 'timeout' }
    })
    const desk = projectHudTaskDesk([task('running'), task('failed'), staleFailure])

    expect(desk.live).toHaveLength(2)
    expect(desk.retired).toBe(1)

    render(<HudTasks tasks={[task('running'), task('failed'), staleFailure]} />)

    expect(screen.getByText('运行中 1')).toBeInTheDocument()
    expect(screen.getByText('需要处理 1')).toBeInTheDocument()
    expect(screen.getByText('已退役历史 1')).toBeInTheDocument()
    expect(screen.queryByText('31 hours old failure')).not.toBeInTheDocument()
  })

  it('explains when every registered task has retired from the live window', () => {
    render(
      <HudTasks
        tasks={[
          task('failed', { freshnessMs: 5 * 60_000 + 1 }),
          task('queued', { freshnessMs: 9e6 })
        ]}
      />
    )

    expect(screen.getByText('当前没有正在心跳的登记任务。')).toBeInTheDocument()
    expect(screen.getByText('已退役历史 2')).toBeInTheDocument()
    expect(screen.queryByText('需要处理 1')).not.toBeInTheDocument()
  })
})
