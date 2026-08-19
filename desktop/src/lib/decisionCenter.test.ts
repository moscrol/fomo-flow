import { describe, expect, it } from 'vitest'

import {
  projectDecisionInbox,
  projectDecisionModelOptions,
  projectPreflight,
  projectRouteEvidence,
  summarizeDecisionCenter,
  summarizePreflight
} from './decisionCenter'

describe('decision center safe projection', () => {
  it('projects bounded preflight order while keeping configured and advisory meaning separate', () => {
    const result = projectPreflight({
      ok: true,
      message: '只是预演，不会发送请求或改变优先级。',
      plan: {
        planId: 'plan-safe',
        profile: 'cheap',
        strategy: 'priority',
        configuredOrder: [
          { provider: 'primary', model: 'm1', source: 'primary', actualPriority: 1 },
          { provider: 'backup', model: 'm2', source: 'fallback', actualPriority: 2 }
        ],
        dispatchOrder: [{ provider: 'primary', model: 'm1', source: 'primary', actualPriority: 1 }],
        excluded: [
          {
            provider: 'backup',
            model: 'm2',
            source: 'fallback',
            actualPriority: 2,
            reason: 'circuit_open'
          }
        ],
        advisoryOrder: [{ provider: 'backup', model: 'm2', actualPriority: 2, advisoryRank: 1 }],
        budget: { status: 'within_cap', capUsd: 0.2, fallback: 'strict' },
        warnings: []
      }
    })

    expect(result).toMatchObject({ profile: 'cheap', strategy: 'priority' })
    expect(result?.configuredOrder.map((item) => item.actualPriority)).toEqual([1, 2])
    expect(result?.dispatchOrder.map((item) => item.provider)).toEqual(['primary'])
    expect(result?.excluded[0].reasonLabel).toBe('渠道暂时熔断')
    expect(result?.advisoryOrder[0].advisoryRank).toBe(1)
  })

  it('uses fixed inbox and evidence copy and removes secrets, paths, and raw ids from text', () => {
    const secret = 'SECRET_SENTINEL'
    const inbox = projectDecisionInbox({
      items: [
        {
          id: 'decision-0123456789abcdef01234567',
          classification: 'budget_rejected',
          status: 'open',
          count: 2,
          title: `Authorization: Bearer ${secret}`,
          message: `/Users/private/${secret}`
        }
      ]
    })
    const evidence = projectRouteEvidence({
      evidence: [
        {
          id: 'evidence-0123456789abcdef01234567',
          linkedPreflightPlanId: 'plan-private-id',
          createdAt: '2026-08-10T03:00:00.000Z',
          plan: {
            profile: 'balanced',
            strategy: 'priority',
            configuredOrder: [
              {
                provider: `/private/${secret}`,
                model: `Authorization: Basic ${secret}`,
                actualPriority: 1
              }
            ]
          },
          events: [
            {
              kind: 'attempt',
              provider: 'primary',
              model: 'm1',
              status: 502,
              errorBody: secret
            }
          ],
          outcome: { status: 'exhausted', failureClass: 'upstream' }
        }
      ]
    })

    expect(inbox[0]).toMatchObject({ title: '本次预算不够', count: 2 })
    expect(evidence[0].linkedPreflight).toBe(true)
    const serialized = JSON.stringify({ inbox, evidence })
    expect(serialized).not.toContain(secret)
    expect(serialized).not.toContain('plan-private-id')
    expect(serialized).not.toContain('/private/')
  })

  it('projects configured routes into bounded safe model options', () => {
    const routes: Record<string, Record<string, unknown>> = Object.fromEntries(
      Array.from({ length: 105 }, (_, index) => [
        `route-${String(index).padStart(3, '0')}`,
        {
          providerName: index === 0 ? 'Anthropic' : `provider-${index}`,
          upstreamModel: index === 0 ? 'claude-sonnet' : `model-${index}`,
          prompt: 'PROMPT_MUST_NOT_RENDER',
          authorization: 'Authorization: Bearer SECRET_MUST_NOT_RENDER'
        }
      ])
    )
    routes['/Users/private/route'] = { provider: 'unsafe', model: 'unsafe' }

    const result = projectDecisionModelOptions({ routes })

    expect(result).toHaveLength(100)
    expect(result[0]).toEqual({
      value: 'route-000',
      label: 'route-000 · Anthropic / claude-sonnet',
      provider: 'Anthropic',
      model: 'claude-sonnet'
    })
    expect(result.map((item) => item.value)).toEqual(
      [...result.map((item) => item.value)].sort((left, right) => left.localeCompare(right))
    )
    expect(JSON.stringify(result)).not.toContain('SECRET_MUST_NOT_RENDER')
    expect(JSON.stringify(result)).not.toContain('PROMPT_MUST_NOT_RENDER')
    expect(JSON.stringify(result)).not.toContain('/Users/private')
  })

  it('summarizes whether attention is needed and the latest real route', () => {
    const normal = summarizeDecisionCenter([], [])
    expect(normal).toMatchObject({
      tone: 'good',
      title: '目前正常',
      openCount: 0,
      latestRoute: '还没有真实请求记录'
    })

    const inbox = projectDecisionInbox({
      items: [
        {
          id: 'decision-0123456789abcdef01234567',
          classification: 'repeated_fallback',
          status: 'open',
          count: 3
        },
        {
          id: 'decision-fedcba987654321001234567',
          classification: 'budget_rejected',
          status: 'open',
          count: 1
        }
      ]
    })
    const evidence = projectRouteEvidence({
      evidence: [
        {
          id: 'evidence-0123456789abcdef01234567',
          createdAt: '2026-08-11T08:00:00.000Z',
          plan: {},
          events: [],
          outcome: { status: 'selected', provider: 'anthropic', model: 'sonnet' }
        }
      ]
    })

    expect(summarizeDecisionCenter(inbox, evidence)).toMatchObject({
      tone: 'danger',
      title: '有 2 项需要处理',
      message: '本次预算不够：所有已知渠道都超过严格预算，需要提高预算或手动调整配置。',
      openCount: 2,
      latestRoute: 'anthropic · sonnet',
      latestOutcome: '已选中渠道'
    })
  })

  it('turns preflight facts into a conclusion before technical lists', () => {
    const base = projectPreflight({
      ok: true,
      plan: {
        configuredOrder: [
          { provider: 'primary', model: 'm1' },
          { provider: 'backup', model: 'm2' }
        ],
        dispatchOrder: [
          { provider: 'primary', model: 'm1' },
          { provider: 'backup', model: 'm2' }
        ],
        excluded: [],
        advisoryOrder: [],
        budget: { status: 'within_cap', fallback: 'strict' }
      }
    })
    expect(summarizePreflight(base!)).toMatchObject({
      tone: 'good',
      title: '预计先走 primary · m1',
      message: '与规定优先级一致。'
    })

    const excluded = {
      ...base!,
      excluded: [
        { ...base!.configuredOrder[1], reason: 'disabled' as const, reasonLabel: '渠道已停用' }
      ]
    }
    expect(summarizePreflight(excluded)).toMatchObject({
      tone: 'warning',
      message: '有 1 个渠道本次不会尝试。'
    })

    const rejected = {
      ...base!,
      dispatchOrder: [],
      budget: { ...base!.budget, status: 'strict_rejected' }
    }
    expect(summarizePreflight(rejected)).toMatchObject({
      tone: 'danger',
      title: '当前预算会阻止发送'
    })

    const drifted = {
      ...base!,
      dispatchOrder: [base!.configuredOrder[1], base!.configuredOrder[0]]
    }
    expect(summarizePreflight(drifted)).toMatchObject({
      tone: 'warning',
      message: '预计尝试顺序与规定优先级不同，请查看详细顺序。'
    })
  })
})
