// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { HudRequests } from './HudRequests'

afterEach(cleanup)

describe('HUD recent request fallback', () => {
  it('labels the safe cache fact as cache and session affinity', () => {
    render(
      <HudRequests
        requests={[
          {
            id: 'safe-row',
            at: 1,
            provider: 'cccc',
            model: 'dao-opus-5',
            source: 'devin',
            cached: 2,
            cacheWrite: 0,
            hitRate: 50,
            cacheMode: 'chat',
            cacheTtl: '5m',
            cacheName: '同一会话',
            cacheStatus: 'hit',
            stablePrefixChars: 0,
            stablePrefixHash: '',
            prefixState: 'rewritten',
            prefixGeneration: 2,
            prefixReason: 'stable-prefix-rewritten',
            ttftMs: 100,
            ttftObserved: true,
            upstreamSemanticMs: 80,
            retryOverheadMs: 0,
            warmup: false,
            cacheDowngrade: '',
            usageObserved: true
          }
        ]}
        sourceFilter="all"
      />
    )

    expect(screen.getByRole('columnheader', { name: '缓存 / 会话亲和' })).toBeInTheDocument()
    expect(screen.queryByRole('columnheader', { name: '缓存名' })).not.toBeInTheDocument()
    expect(screen.getByText('同一会话')).toBeInTheDocument()
    expect(screen.getByText('已重排')).toBeInTheDocument()
    expect(screen.getByText('上下文被重排，上游无法复用前缀')).toBeInTheDocument()
  })

  it('explains append-only and new-family prefix states without exposing hashes as the label', () => {
    const base = {
      id: 'safe-row',
      at: 1,
      provider: 'cccc',
      model: 'dao-opus-5',
      source: 'devin',
      cached: 0,
      cacheWrite: 0,
      hitRate: 0,
      cacheMode: 'implicit',
      cacheTtl: 'provider',
      cacheName: '同一会话',
      cacheStatus: 'miss',
      stablePrefixChars: 12000,
      stablePrefixHash: 'abcdef123456',
      ttftMs: 100,
      ttftObserved: true,
      upstreamSemanticMs: 80,
      retryOverheadMs: 0,
      warmup: false,
      cacheDowngrade: '',
      usageObserved: true
    }
    render(
      <HudRequests
        requests={[
          {
            ...base,
            id: 'append',
            prefixState: 'append-only',
            prefixGeneration: 1,
            prefixReason: 'stable-prefix-extended'
          },
          {
            ...base,
            id: 'family',
            prefixState: 'family-changed',
            prefixGeneration: 2,
            prefixReason: 'cache-family-changed'
          }
        ]}
        sourceFilter="all"
      />
    )

    expect(screen.getByText('仅追加')).toBeInTheDocument()
    expect(screen.getByText('前缀连续，可复用')).toBeInTheDocument()
    expect(screen.getByText('新缓存族')).toBeInTheDocument()
    expect(screen.getByText('缓存族刚切换，需要重新建立缓存')).toBeInTheDocument()
    expect(screen.queryByText('abcdef123456')).not.toBeInTheDocument()
  })

  it('shows safe request-chain facts when cache samples are temporarily empty', () => {
    render(
      <HudRequests
        fallbackTraces={[
          {
            at: '刚刚',
            source: '请求链路',
            provider: 'dp',
            model: 'deepseek-v4-flash',
            state: '已完成'
          }
        ]}
        requests={[]}
        sourceFilter="all"
      />
    )

    expect(
      screen.getByText('已发生 1 条请求，但缓存 token 尚未回填；以下是请求链路事实。')
    ).toBeInTheDocument()
    expect(screen.getByText('deepseek-v4-flash')).toBeInTheDocument()
    expect(screen.queryByText('等待首个缓存观测样本')).not.toBeInTheDocument()
  })

  it('hides the legacy fake prefix length even when a family change was observed', () => {
    render(
      <HudRequests
        requests={[
          {
            id: 'legacy-row',
            at: 1,
            provider: 'cccc',
            model: 'claude-opus-5',
            source: 'devin',
            cached: 0,
            cacheWrite: 0,
            hitRate: 0,
            cacheMode: 'implicit',
            cacheTtl: 'provider',
            cacheName: '同一会话',
            cacheStatus: 'miss',
            stablePrefixChars: 2,
            stablePrefixHash: '44136fa355b3',
            prefixState: 'family-changed',
            prefixGeneration: 2,
            prefixReason: 'cache-family-changed',
            ttftMs: null,
            ttftObserved: false,
            upstreamSemanticMs: null,
            retryOverheadMs: null,
            warmup: false,
            cacheDowngrade: '',
            usageObserved: true
          }
        ]}
        sourceFilter="all"
      />
    )

    expect(screen.getByText('新缓存族')).toBeInTheDocument()
    expect(screen.getByText('缓存族刚切换，需要重新建立缓存')).toBeInTheDocument()
    expect(screen.queryByText('2 ch')).not.toBeInTheDocument()
    expect(screen.getByText('第 2 代')).toBeInTheDocument()
  })
})
