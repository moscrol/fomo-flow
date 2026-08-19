// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { RouteRelayHop } from '@/lib/routeRelay'

import { RouteRelaySheet } from './RouteRelaySheet'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('route relay sheet', () => {
  it('explains configured order, skips, recovery, and the first dispatch hop', () => {
    const hops: RouteRelayHop[] = [
      {
        provider: 'first',
        model: 'm1',
        actualPriority: 1,
        state: 'skipped',
        dispatchPosition: null,
        reasonLabel: '渠道暂时熔断',
        circuitCategory: 'rate_limit',
        circuitLabel: '上游限流',
        remainingMs: 90_000
      },
      {
        provider: 'second',
        model: 'm2',
        actualPriority: 2,
        state: 'ready',
        dispatchPosition: 1,
        reasonLabel: '',
        circuitCategory: null,
        circuitLabel: '',
        remainingMs: null
      },
      {
        provider: 'third',
        model: 'm3',
        actualPriority: 3,
        state: 'ready',
        dispatchPosition: 2,
        reasonLabel: '',
        circuitCategory: null,
        circuitLabel: '',
        remainingMs: null
      }
    ]

    render(<RouteRelaySheet hops={hops} />)

    expect(screen.getByRole('heading', { name: '路由接力单' })).toBeInTheDocument()
    expect(screen.getByText('规定 #1 · first · m1')).toBeInTheDocument()
    expect(screen.getByText('本次跳过')).toBeInTheDocument()
    expect(screen.getByText('渠道暂时熔断 · 上游限流')).toBeInTheDocument()
    expect(screen.getByText('约 1 分 30 秒后可再尝试')).toBeInTheDocument()
    expect(screen.getByText('可尝试 · 预计第一跳')).toBeInTheDocument()
    expect(screen.getByText('可尝试 · 后备第 1 跳')).toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('does not describe strict-budget-blocked hops as ready', () => {
    render(
      <RouteRelaySheet
        hops={[
          {
            provider: 'first',
            model: 'm1',
            actualPriority: 1,
            state: 'blocked',
            dispatchPosition: null,
            reasonLabel: '严格预算阻止发送',
            circuitCategory: null,
            circuitLabel: '',
            remainingMs: null
          }
        ]}
      />
    )

    expect(screen.getByText('预算阻止发送')).toBeInTheDocument()
    expect(screen.getByText('严格预算阻止发送')).toBeInTheDocument()
    expect(screen.queryByText(/可尝试/)).not.toBeInTheDocument()
  })

  it('counts circuit recovery down and asks for a new check at the recovery window', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    render(
      <RouteRelaySheet
        hops={[
          {
            provider: 'first',
            model: 'm1',
            actualPriority: 1,
            state: 'skipped',
            dispatchPosition: null,
            reasonLabel: '渠道暂时熔断',
            circuitCategory: 'rate_limit',
            circuitLabel: '上游限流',
            remainingMs: 90_000
          }
        ]}
      />
    )

    expect(vi.getTimerCount()).toBe(1)
    expect(screen.getByText('约 1 分 30 秒后可再尝试')).toBeInTheDocument()
    await act(async () => vi.advanceTimersByTimeAsync(60_000))
    expect(screen.getByText('约 30 秒后可再尝试')).toBeInTheDocument()
    await act(async () => vi.advanceTimersByTimeAsync(30_000))
    expect(screen.getByText('恢复窗口已到，请重新检查')).toBeInTheDocument()
    expect(vi.getTimerCount()).toBe(0)
  })
})
