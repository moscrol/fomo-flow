// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { DAO_VIEW_DEFINITIONS } from '@/lib/views'

import { Sidebar } from './Sidebar'

const baseProps = {
  views: DAO_VIEW_DEFINITIONS,
  status: null,
  onOpenCommandPalette: vi.fn(),
  onSelect: vi.fn()
}

describe('Dao sidebar navigation groups', () => {
  afterEach(() => cleanup())

  it('shows four task-oriented entries and highlights the owner of a hidden child', async () => {
    const onSelect = vi.fn()
    render(<Sidebar {...baseProps} activeView="routes" onSelect={onSelect} />)

    const navigation = screen.getByRole('navigation', { name: 'Dao 主要功能' })
    expect(navigation.querySelectorAll('.view-nav-item')).toHaveLength(4)
    expect(screen.getByRole('button', { name: '当前工作' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '流量观测' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'ACP 协作' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '设置' })).toHaveAttribute('aria-current', 'page')
    expect(screen.queryByRole('button', { name: '模型怎么走' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '首页' })).not.toBeInTheDocument()

    screen.getByRole('button', { name: '设置' }).click()
    expect(onSelect).toHaveBeenCalledWith('settings')
  })
})
