// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { HudProviders } from './HudProviders'
import type { HudProvider } from './hudProjection'

afterEach(cleanup)

const baseProvider: HudProvider = {
  id: 'cccc',
  state: 'unknown',
  ageMs: 0,
  model: 'claude-opus-5',
  calls: 50,
  hitRate: 95.4,
  recentCalls: 0,
  recentHitRate: 0,
  latency: {
    overall: { p50TtftMs: 100, p95TtftMs: 200 },
    cache: { hit: { p50TtftMs: 80, p95TtftMs: 120 }, miss: { p50TtftMs: 250, p95TtftMs: 300 } }
  },
  circuit: null
}

describe('HudProviders', () => {
  it('uses cumulative hit rate when the recent window has no samples', () => {
    render(<HudProviders providers={[baseProvider]} />)

    expect(screen.getByText('累计 HIT')).toBeInTheDocument()
    expect(screen.getByText('95.4%')).toBeInTheDocument()
    expect(screen.queryByText('0%')).not.toBeInTheDocument()
  })

  it('uses recent hit rate when the recent window has samples', () => {
    render(<HudProviders providers={[{ ...baseProvider, recentCalls: 3, recentHitRate: 66.7 }]} />)

    expect(screen.getByText('近期 HIT')).toBeInTheDocument()
    expect(screen.getByText('66.7%')).toBeInTheDocument()
    expect(screen.getByText('累计 HIT')).toBeInTheDocument()
    expect(screen.getByText('95.4%')).toBeInTheDocument()
  })
})
