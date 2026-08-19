// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { normalizeCollaborationSnapshot } from './collaborationModel'
import { CollaborationAttentionQueue } from './CollaborationAttentionQueue'

afterEach(cleanup)

describe('CollaborationAttentionQueue', () => {
  it('renders priority items and selects a session without exposing its id', async () => {
    const user = userEvent.setup()
    const onSelectSession = vi.fn()
    const sessions = normalizeCollaborationSnapshot({
      sessions: [
        {
          id: 'blocked-private-id',
          surface: 'acp',
          active: true,
          lifecycle: 'running',
          goal: '处理验证阻塞',
          phase: '验证',
          latestActivityAt: 9_000,
          verification: { blocking: true, status: 'pending' }
        },
        {
          id: 'watch-private-id',
          surface: 'acp',
          active: true,
          requestInFlight: true,
          lifecycle: 'running',
          goal: '观察在途会话',
          phase: '等待上游',
          latestActivityAt: 8_000
        }
      ]
    }).sessions

    render(
      <CollaborationAttentionQueue
        now={10_000}
        onSelectSession={onSelectSession}
        selectedSessionId=""
        sessions={sessions}
      />
    )

    expect(screen.getByRole('region', { name: '人工接手队列' })).toBeInTheDocument()
    expect(screen.getByText('验证阻塞')).toBeInTheDocument()
    expect(screen.getByText('处理验证阻塞')).toBeInTheDocument()
    const button = screen.getByRole('button', { name: '查看会话：处理验证阻塞' })
    expect(button).not.toHaveAccessibleName('blocked-private-id')

    await user.click(button)
    expect(onSelectSession).toHaveBeenCalledWith('blocked-private-id')
  })

  it('renders an explicit empty state when no session needs attention', () => {
    const onSelectSession = vi.fn()
    const sessions = normalizeCollaborationSnapshot({
      sessions: [
        {
          id: 'healthy-private-id',
          surface: 'acp',
          active: true,
          requestInFlight: false,
          lifecycle: 'running',
          goal: '健康会话'
        }
      ]
    }).sessions

    render(
      <CollaborationAttentionQueue
        now={10_000}
        onSelectSession={onSelectSession}
        selectedSessionId=""
        sessions={sessions}
      />
    )

    expect(screen.getByText('当前没有需要人工接手的会话。')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /查看会话/ })).not.toBeInTheDocument()
  })
})
