// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { PromoteWorkDraft } from '@/lib/desktopHost'
import { PromoteWorkDialog } from './PromoteWorkDialog'

const draft: PromoteWorkDraft = {
  fingerprint: '0'.repeat(32),
  title: '构建失败',
  sourceKind: 'task',
  failureKind: 'failed',
  acceptance: '修复后完成一次验证。'
}

afterEach(cleanup)

describe('promote work dialog', () => {
  it('renders nothing while closed', () => {
    render(
      <PromoteWorkDialog
        open={false}
        draft={draft}
        writable={false}
        busy={false}
        status=""
        onCancel={() => undefined}
        onConfirm={() => undefined}
      />
    )
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('shows a safe preview but disables writes without attribution', () => {
    const onConfirm = vi.fn()
    render(
      <PromoteWorkDialog
        open
        draft={draft}
        writable={false}
        busy={false}
        status=""
        onCancel={() => undefined}
        onConfirm={onConfirm}
      />
    )

    expect(screen.getByRole('dialog', { name: '加入任务板预览' })).toBeInTheDocument()
    expect(screen.getByText('构建失败')).toBeInTheDocument()
    expect(screen.getByText('修复后完成一次验证。')).toBeInTheDocument()
    expect(screen.getByText('需要从当前 Codex 任务发起')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '确认加入任务板' })).toBeDisabled()
    expect(onConfirm).not.toHaveBeenCalled()
    expect(screen.queryByText(draft.fingerprint)).not.toBeInTheDocument()
  })

  it('writes only after explicit confirmation and never on open or cancel', () => {
    const onCancel = vi.fn()
    const onConfirm = vi.fn()
    render(
      <PromoteWorkDialog
        open
        draft={draft}
        writable
        busy={false}
        status=""
        onCancel={onCancel}
        onConfirm={onConfirm}
      />
    )

    expect(onConfirm).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onConfirm).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '确认加入任务板' }))
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })
})
