// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { HudRuntimeStrip } from './HudRuntimeStrip'
import { emptyHudSnapshot } from './hudProjection'

describe('HUD runtime source label', () => {
  it('shows which local Dao instance owns the displayed facts', () => {
    render(
      <HudRuntimeStrip
        now={1_000}
        snapshot={{
          ...emptyHudSnapshot,
          runtime: { ...emptyHudSnapshot.runtime, healthy: true, connection: 'live', port: 8955 }
        }}
      />
    )

    expect(screen.getByText('数据源')).toBeInTheDocument()
    expect(screen.getByText('本机 :8955')).toBeInTheDocument()
  })
})
