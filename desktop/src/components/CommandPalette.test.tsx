// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { DAO_VIEW_DEFINITIONS } from '@/lib/views'

import { CommandPalette } from './CommandPalette'

describe('Dao command palette', () => {
  afterEach(() => cleanup())

  it('filters views and selects the highlighted result', async () => {
    const user = userEvent.setup()
    const onSelect = vi.fn()
    const onClose = vi.fn()
    render(
      <CommandPalette
        open
        views={[
          {
            id: 'overview',
            label: '首页',
            eyebrow: '运行中',
            description: '现在是否正常、下一步做什么',
            group: 'runtime'
          },
          {
            id: 'revproxy',
            label: '本地接口',
            eyebrow: '配置',
            description: '给客户端使用的本地接口',
            group: 'config'
          }
        ]}
        onSelect={onSelect}
        onClose={onClose}
      />
    )

    await user.type(screen.getByPlaceholderText('搜索命令或视图'), '接口')
    expect(screen.getByRole('option', { name: /本地接口/ })).toBeVisible()
    await user.keyboard('{Enter}')
    expect(onSelect).toHaveBeenCalledWith('revproxy')
  })

  it('keeps hidden configuration views searchable under their primary owner', async () => {
    const user = userEvent.setup()
    render(
      <CommandPalette open views={DAO_VIEW_DEFINITIONS} onSelect={vi.fn()} onClose={vi.fn()} />
    )

    await user.type(screen.getByPlaceholderText('搜索命令或视图'), '模型怎么走')

    expect(screen.getByRole('option', { name: /模型怎么走/ })).toHaveTextContent(
      '设置 · 决定 Devin/Codex 请求走哪家'
    )
  })
})
