// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { SectionShellNav } from './SectionShellNav'

describe('SectionShellNav', () => {
  it('marks the selected child and navigates without owning child behavior', () => {
    const onSelect = vi.fn()
    render(
      <SectionShellNav
        label="设置分区"
        activeView="routes"
        items={[
          { id: 'settings', label: '设置首页' },
          { id: 'routes', label: '模型路由' }
        ]}
        onSelect={onSelect}
      />
    )

    expect(screen.getByRole('button', { name: '模型路由' })).toHaveAttribute('aria-current', 'page')
    fireEvent.click(screen.getByRole('button', { name: '设置首页' }))
    expect(onSelect).toHaveBeenCalledWith('settings')
  })
})
