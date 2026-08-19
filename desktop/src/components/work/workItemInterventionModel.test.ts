import { describe, expect, it } from 'vitest'

import { buildInterventionSummary } from './workItemInterventionModel'

describe('buildInterventionSummary', () => {
  it('projects the advisory profile and candidates from the latest routing decision', () => {
    const summary = buildInterventionSummary({
      decisions: [
        {
          profile: 'coding',
          candidates: [
            { provider: 'first', model: 'm1', advisoryScore: 0.7, reason: '任务匹配' },
            { provider: 'second', model: 'm2', advisoryScore: 0.5 }
          ]
        }
      ]
    })

    expect(summary).toMatchObject({ profile: 'coding', profileSource: 'advisory' })
    expect(summary.candidates.map(({ provider }) => provider)).toEqual(['first', 'second'])
  })

  it('uses a marked balanced fallback only when the payload has no valid profile', () => {
    expect(buildInterventionSummary({ decisions: [] })).toMatchObject({
      profile: 'balanced',
      profileSource: 'default'
    })
    expect(
      buildInterventionSummary({ decisions: [{ profile: 'unknown', candidates: [] }] })
    ).toMatchObject({ profile: 'balanced', profileSource: 'default' })
  })

  it('projects candidates and supported aliases', () => {
    expect(
      buildInterventionSummary({
        decisions: [{ provider: 'openai', model: 'gpt', advisoryScore: '1.25', reason: '稳定' }]
      })
    ).toEqual({
      advisoryOnly: true,
      message: '仅供比较，不会自动切换。',
      profile: 'balanced',
      profileSource: 'default',
      candidates: [
        { provider: 'openai', model: 'gpt', score: 1.25, reason: '稳定', advisoryOnly: true }
      ]
    })
  })

  it('reads nested data decisions', () => {
    expect(
      buildInterventionSummary({
        data: { decisions: [{ provider: 'p', modelUid: 'm', why: '可比' }] }
      }).candidates[0]
    ).toMatchObject({ provider: 'p', model: 'm', reason: '可比' })
  })

  it('supports providerName and modelUid aliases', () => {
    expect(
      buildInterventionSummary({ decisions: [{ providerName: 'p', modelUid: 'm' }] }).candidates[0]
    ).toMatchObject({ provider: 'p', model: 'm' })
  })

  it('returns fixed empty advisory summary for malformed payloads', () => {
    for (const payload of [
      null,
      undefined,
      'bad',
      {},
      { data: { decisions: 'bad' } },
      { decisions: [null, 3] }
    ]) {
      expect(buildInterventionSummary(payload)).toEqual({
        advisoryOnly: true,
        message: '仅供比较，不会自动切换。',
        profile: 'balanced',
        profileSource: 'default',
        candidates: []
      })
    }
  })

  it('keeps input order and caps candidates at five', () => {
    const decisions = Array.from({ length: 7 }, (_, index) => ({
      provider: `p${index}`,
      model: `m${index}`
    }))
    expect(
      buildInterventionSummary({ decisions }).candidates.map((candidate) => candidate.provider)
    ).toEqual(['p0', 'p1', 'p2', 'p3', 'p4'])
  })

  it('redacts secrets, paths, prompt and authorization never enter output', () => {
    const payload = {
      prompt: 'do not leak this prompt',
      Authorization: 'Bearer auth-secret',
      target: 'target-id',
      sessionId: 'session-id',
      jobId: 'job-id',
      decisions: [
        {
          provider: 'Bearer provider-token',
          model: 'sk-secret /Users/private/model',
          score: Infinity,
          reason: 'why /home/private/x C:\\private\\x'
        }
      ]
    }
    const rendered = JSON.stringify(buildInterventionSummary(payload))
    expect(rendered).not.toMatch(
      /Bearer|sk-secret|\/Users|\/home|C:\\\\private|do not leak|target-id|session-id|job-id|auth-secret/
    )
  })

  it('uses the shared sanitizer for every authorization scheme and local path root', () => {
    const rendered = JSON.stringify(
      buildInterventionSummary({
        decisions: [
          {
            provider: 'Authorization: Basic abc123 /etc/dao',
            model: 'Digest digest-token /var/lib/dao',
            reason: 'Token token-value /opt/dao /tmp/dao /home/dao /Users/dao file:///var/dao'
          }
        ]
      })
    )
    expect(rendered).not.toMatch(
      /Basic\s+abc123|Digest\s+digest-token|Token\s+token-value|\/(?:etc|var|opt|tmp|home|Users)\//i
    )
    expect(rendered).toContain('[凭据已隐藏]')
    expect(rendered).toContain('[路径已隐藏]')
  })

  it('clamps finite scores and nulls invalid values', () => {
    const result = buildInterventionSummary({
      decisions: [
        { provider: 'p', model: 'a', score: 9e99 },
        { provider: 'p', model: 'b', score: '-Infinity' },
        { provider: 'p', model: 'c', score: '-2e6' }
      ]
    })
    expect(result.candidates.map((candidate) => candidate.score)).toEqual([
      1_000_000,
      null,
      -1_000_000
    ])
  })
})
