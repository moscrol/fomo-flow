// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { emptyDaoDashboardSnapshot, type DaoDesktopStatus } from '@/lib/desktopHost'

import { OverviewView } from './OverviewView'

const status: DaoDesktopStatus = {
  healthy: true,
  running: true,
  port: 8955,
  url: 'http://127.0.0.1:8955',
  profile: 'desktop',
  imported: { config: true, revproxy: true },
  error: null
}

describe('Dao beginner home', () => {
  it('offers plain-language next steps', async () => {
    const user = userEvent.setup()
    const onNavigate = vi.fn()
    render(
      <OverviewView
        status={status}
        snapshot={{
          ...emptyDaoDashboardSnapshot,
          providers: [
            {
              name: 'deepseek',
              label: 'DeepSeek',
              type: 'openai',
              endpointHost: 'api.deepseek.com',
              enabled: true,
              builtin: false,
              modelCount: 1,
              models: ['deepseek-chat'],
              health: { alive: true, status: 200, reason: null },
              usage: { calls: 3, input: 10, output: 5, total: 15 }
            }
          ]
        }}
        onRetry={vi.fn()}
        onNavigate={onNavigate}
      />
    )

    expect(screen.getByRole('heading', { name: '现在正常吗？' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '我要接入渠道' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '我要决定模型走哪家' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '我要看任务和会话' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '管理渠道' }))
    expect(onNavigate).toHaveBeenCalledWith('providers')
  })
})
