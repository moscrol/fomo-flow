// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { SettingsControlView } from './SettingsControlView'

describe('SettingsControlView', () => {
  it('keeps every retained configuration capability reachable by purpose', () => {
    const onNavigate = vi.fn()
    render(<SettingsControlView onNavigate={onNavigate} />)

    for (const label of [
      '接入渠道',
      '模型路由',
      '自定义模型',
      'Codex 连接',
      '外部客户端',
      '本地接口',
      '协议兼容',
      '远程访问'
    ]) {
      expect(screen.getByRole('button', { name: new RegExp(label) })).toBeInTheDocument()
    }

    fireEvent.click(screen.getByRole('button', { name: /模型路由/ }))
    expect(onNavigate).toHaveBeenCalledWith('routes')
  })
})
