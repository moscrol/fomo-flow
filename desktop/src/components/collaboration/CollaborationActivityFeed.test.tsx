// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import { normalizeCollaborationSnapshot } from './collaborationModel'
import { CollaborationActivityFeed } from './CollaborationActivityFeed'

describe('CollaborationActivityFeed', () => {
  it('filters semantic events and reveals only safe raw fields on demand', async () => {
    const user = userEvent.setup()
    const snapshot = normalizeCollaborationSnapshot({
      sessions: [
        {
          id: 'feed-session',
          surface: 'acp',
          active: true,
          warning: true,
          lifecycle: 'running',
          goal: '整理协作交接',
          phase: '执行工具',
          latestActivityAt: 2_000,
          route: {
            provider: 'bridge',
            modelUid: 'dao-model',
            upstreamModel: 'upstream',
            provisional: false
          },
          todo: { completed: 1, total: 2, current: '整理产物' }
        }
      ],
      recentRequests: [
        {
          id: 'feed-request',
          at: 1_900,
          source: 'acp',
          provider: 'bridge',
          model: 'upstream',
          success: false,
          status: 'failed',
          errorCategory: 'timeout'
        }
      ]
    })

    render(
      <CollaborationActivityFeed
        session={snapshot.sessions[0]}
        requests={snapshot.recentRequests}
        now={2_000}
      />
    )

    expect(screen.getByRole('region', { name: '语义活动流' })).toBeInTheDocument()
    expect(screen.getByText('需要关注')).toBeInTheDocument()
    expect(screen.getByText('失败 · timeout')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '结果' }))
    expect(screen.getByText('失败 · timeout')).toBeInTheDocument()
    expect(screen.queryByText('推进 · 整理产物')).not.toBeInTheDocument()

    await user.click(screen.getByText('查看原始事件'))
    expect(screen.getByText(/"status": "failed"/)).toBeInTheDocument()
  })
})
