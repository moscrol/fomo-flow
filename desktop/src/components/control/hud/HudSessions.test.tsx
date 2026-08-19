// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { HudSessions } from './HudSessions'
import { toHudSnapshot } from './hudProjection'

afterEach(cleanup)

describe('HUD session lifecycle explanation', () => {
  it('makes the automatic retirement rule visible', () => {
    render(
      <HudSessions
        now={1_000}
        onSelectSession={vi.fn()}
        onSelectSurface={vi.fn()}
        providers={[]}
        selectedSessionId=""
        sessions={[]}
        surfaceFilter="all"
      />
    )

    expect(screen.getByText('超过 5 分钟无活动即退出当前工作，历史不删除。')).toBeInTheDocument()
  })

  it('shows the current model on the session card without requiring detail navigation', () => {
    const sessions = toHudSnapshot({
      sessions: [
        {
          id: 'safe-session-id',
          surface: 'devin',
          active: true,
          latestActivityAt: 900,
          goal: '检查当前模型',
          route: {
            modelUid: 'swe-1-6-slow',
            provider: 'dp',
            upstreamModel: 'deepseek-v4-flash',
            provisional: false
          }
        }
      ]
    }).sessions

    render(
      <HudSessions
        now={1_000}
        onSelectSession={vi.fn()}
        onSelectSurface={vi.fn()}
        providers={[]}
        selectedSessionId=""
        sessions={sessions}
        surfaceFilter="all"
      />
    )

    expect(screen.getAllByText('正在使用的模型').length).toBeGreaterThan(0)
    expect(screen.getAllByText('deepseek-v4-flash').length).toBeGreaterThan(0)
    expect(screen.getByText('渠道 dp · 路由名 swe-1-6-slow')).toBeInTheDocument()
    expect(screen.getByText('路由名')).toBeInTheDocument()
  })
})
