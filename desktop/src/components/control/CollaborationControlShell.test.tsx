// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { CollaborationControlShell } from './CollaborationControlShell'

describe('CollaborationControlShell', () => {
  it('keeps task details inside the ACP collaboration navigation', () => {
    render(
      <CollaborationControlShell activeView="tasks" onNavigate={vi.fn()}>
        <h2>任务详情</h2>
      </CollaborationControlShell>
    )

    expect(screen.getByRole('navigation', { name: 'ACP 协作分区' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '任务与产物' })).toHaveAttribute(
      'aria-current',
      'page'
    )
    expect(screen.getByRole('heading', { name: '任务详情' })).toBeInTheDocument()
  })
})
