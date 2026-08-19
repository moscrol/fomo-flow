// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { HudKpiStrip } from './HudKpiStrip'
import { toHudSnapshot } from './hudProjection'

describe('HUD KPI strip', () => {
  it('surfaces observed session cache when the global request window is empty', () => {
    const snapshot = toHudSnapshot({
      version: 1,
      totals: { calls: 0, hitRate: 0, cached: 0, cacheWrite: 0 },
      sessions: [
        {
          id: 'safe-session',
          active: true,
          cache: { observed: true, calls: 3, cached: 1200, cacheWrite: 10, hitRate: 93.7 }
        }
      ]
    })

    render(<HudKpiStrip snapshot={snapshot} />)

    expect(screen.getByText('会话缓存命中')).toBeInTheDocument()
    expect(screen.getByText('93.7%')).toBeInTheDocument()
    expect(screen.getByText('全局请求样本待累计')).toBeInTheDocument()
  })

  it('does not present a false zero before any cache observation exists', () => {
    render(<HudKpiStrip snapshot={toHudSnapshot({ version: 1 })} />)

    expect(screen.getByText('全局缓存命中')).toBeInTheDocument()
    expect(screen.getByText('—')).toBeInTheDocument()
    expect(screen.getByText('等待首个真实请求样本')).toBeInTheDocument()
  })
})
