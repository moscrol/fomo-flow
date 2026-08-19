// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { TrafficControlShell } from './TrafficControlShell'

describe('TrafficControlShell', () => {
  it('keeps routing evidence under the direct traffic observation navigation', () => {
    render(
      <TrafficControlShell activeView="decisions" onNavigate={vi.fn()}>
        <h2>路由证据内容</h2>
      </TrafficControlShell>
    )

    expect(screen.getByRole('navigation', { name: '流量观测分区' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '为什么这样走' })).toHaveAttribute(
      'aria-current',
      'page'
    )
    expect(screen.getByRole('button', { name: '运行健康' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '路由证据内容' })).toBeInTheDocument()
  })
})
