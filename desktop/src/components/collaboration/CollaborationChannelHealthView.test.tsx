// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { normalizeCollaborationSnapshot } from './collaborationModel'
import { CollaborationChannelHealthView } from './CollaborationChannelHealthView'

afterEach(cleanup)

describe('CollaborationChannelHealth', () => {
  it('renders channel traffic, latency, cache facts, and failure state', () => {
    const snapshot = normalizeCollaborationSnapshot({
      providers: [
        {
          id: 'bridge',
          latency: {
            overall: { p95TtftMs: 720 },
            cache: { hit: { p95TtftMs: 180 }, miss: { p95TtftMs: 420 } }
          }
        }
      ],
      sessions: [{ id: 'private-session-id', route: { provider: 'bridge' } }],
      recentRequests: [
        { id: 'private-request-id', provider: 'bridge', status: 'failed', success: false }
      ]
    })

    render(
      <CollaborationChannelHealthView
        providers={snapshot.providers}
        recentRequests={snapshot.recentRequests}
        sessions={snapshot.sessions}
      />
    )

    expect(screen.getByRole('region', { name: '渠道健康矩阵' })).toBeInTheDocument()
    expect(screen.getByText('bridge')).toBeInTheDocument()
    expect(screen.getByText('720 ms')).toBeInTheDocument()
    expect(screen.getByText('180 ms')).toBeInTheDocument()
    expect(screen.getByText('420 ms')).toBeInTheDocument()
    expect(screen.getByText('告警')).toBeInTheDocument()
    expect(screen.getByText(/1 次失败/)).toBeInTheDocument()
    expect(screen.queryByText('private-session-id')).not.toBeInTheDocument()
    expect(screen.queryByText('private-request-id')).not.toBeInTheDocument()
  })

  it('renders an explicit empty state without provider observations', () => {
    render(<CollaborationChannelHealthView providers={[]} recentRequests={[]} sessions={[]} />)

    expect(screen.getByText('暂无渠道观测')).toBeInTheDocument()
    expect(screen.queryByRole('list', { name: '渠道健康概览' })).not.toBeInTheDocument()
  })
})
