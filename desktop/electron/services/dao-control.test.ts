import { describe, expect, it, vi } from 'vitest'

import {
  controlRequestUrl,
  isDaoObservationRequest,
  isAllowedDaoControlRequest,
  readDaoControlResponse,
  readDaoLocalApiKey,
  requiresDaoTaskAuthorization
} from './dao-control'

describe('Dao observation request boundary', () => {
  it('routes only the exact read-only HUD snapshot through live-source selection', () => {
    expect(isDaoObservationRequest({ path: '/origin/hud/snapshot', method: 'GET' })).toBe(true)
    expect(
      isDaoObservationRequest({ path: '/origin/hud/snapshot', method: 'POST', body: {} })
    ).toBe(false)
    expect(isDaoObservationRequest({ path: '/origin/hud/snapshot/extra', method: 'GET' })).toBe(
      false
    )
    expect(isDaoObservationRequest({ path: '/origin/ea/usage', method: 'GET' })).toBe(true)
    expect(isDaoObservationRequest({ path: '/origin/ea/alerts?limit=12', method: 'GET' })).toBe(
      true
    )
    expect(
      isDaoObservationRequest({ path: '/origin/ea/alerts?limit=12&token=secret', method: 'GET' })
    ).toBe(false)
    expect(isDaoObservationRequest({ path: '/origin/ea/usage?limit=12', method: 'GET' })).toBe(
      false
    )
    expect(isDaoObservationRequest({ path: '/origin/ea/traces?limit=0', method: 'GET' })).toBe(
      false
    )
    expect(isDaoObservationRequest({ path: '/origin/ea/audit?limit=12', method: 'GET' })).toBe(
      false
    )
    expect(isDaoObservationRequest({ path: '/origin/tasks', method: 'GET' })).toBe(true)
    expect(isDaoObservationRequest({ path: '/origin/tasks?token=secret', method: 'GET' })).toBe(
      false
    )
  })
})

describe('Dao native control API boundary', () => {
  it('allows only the component control endpoints', () => {
    expect(isAllowedDaoControlRequest({ path: '/origin/hud/snapshot', method: 'GET' })).toBe(true)
    expect(isAllowedDaoControlRequest({ path: '/origin/ea/alerts?limit=12', method: 'GET' })).toBe(
      true
    )
    expect(
      isAllowedDaoControlRequest({
        path: '/origin/ea/alerts?limit=12&token=secret',
        method: 'GET'
      })
    ).toBe(false)
    expect(
      isAllowedDaoControlRequest({ path: '/origin/ea/usage?token=secret', method: 'GET' })
    ).toBe(false)
    expect(isAllowedDaoControlRequest({ path: '/origin/tasks', method: 'GET' })).toBe(true)
    expect(isAllowedDaoControlRequest({ path: '/origin/tasks?token=secret', method: 'GET' })).toBe(
      false
    )
    expect(isAllowedDaoControlRequest({ path: '/origin/tasks/job-1', method: 'GET' })).toBe(true)
    expect(isAllowedDaoControlRequest({ path: '/origin/tasks', method: 'POST', body: {} })).toBe(
      false
    )
    expect(
      isAllowedDaoControlRequest({ path: '/origin/tasks/job-1/result', method: 'POST', body: {} })
    ).toBe(false)
    expect(isAllowedDaoControlRequest({ path: '/origin/ea/overview', method: 'GET' })).toBe(true)
    expect(isAllowedDaoControlRequest({ path: '/origin/ea/config-pack', method: 'GET' })).toBe(true)
    expect(
      isAllowedDaoControlRequest({
        path: '/origin/ea/routing-decisions?profile=cheap&limit=20',
        method: 'GET'
      })
    ).toBe(true)
    expect(
      isAllowedDaoControlRequest({
        path: '/origin/ea/routing-decisions/anything',
        method: 'GET'
      })
    ).toBe(false)
    expect(
      isAllowedDaoControlRequest({
        path: '/origin/ea/routing-decisions',
        method: 'POST',
        body: {}
      })
    ).toBe(false)
    expect(
      isAllowedDaoControlRequest({
        path: '/origin/ea/route-preflight',
        method: 'POST',
        body: { model: 'MODEL_PREFLIGHT', profile: 'balanced' }
      })
    ).toBe(true)
    expect(
      isAllowedDaoControlRequest({
        path: '/origin/ea/route-preflight/extra',
        method: 'POST',
        body: {}
      })
    ).toBe(false)
    expect(
      isAllowedDaoControlRequest({ path: '/origin/ea/decision-inbox?limit=20', method: 'GET' })
    ).toBe(true)
    expect(
      isAllowedDaoControlRequest({ path: '/origin/ea/decision-inbox/anything', method: 'GET' })
    ).toBe(false)
    expect(
      isAllowedDaoControlRequest({ path: '/origin/ea/route-evidence?limit=20', method: 'GET' })
    ).toBe(true)
    expect(
      isAllowedDaoControlRequest({
        path: '/origin/ea/decision-inbox/decision-0123456789abcdef01234567/ack',
        method: 'POST',
        body: {}
      })
    ).toBe(true)
    expect(
      isAllowedDaoControlRequest({
        path: '/origin/ea/decision-inbox/decision-0123456789abcdef01234567/snooze',
        method: 'POST',
        body: { minutes: 60 }
      })
    ).toBe(true)
    expect(
      isAllowedDaoControlRequest({
        path: '/origin/ea/decision-inbox/not-safe/ack',
        method: 'POST',
        body: {}
      })
    ).toBe(false)
    expect(
      isAllowedDaoControlRequest({
        path: '/origin/ea/decision-inbox/decision-0123456789abcdef01234567/delete',
        method: 'POST',
        body: {}
      })
    ).toBe(false)
    expect(
      isAllowedDaoControlRequest({
        path: '/origin/ea/route-preflight',
        method: 'POST',
        body: { model: 'x'.repeat(17 * 1024) }
      })
    ).toBe(false)
    expect(
      isAllowedDaoControlRequest({
        path: '/origin/revproxy/models',
        method: 'POST',
        body: { modelUid: 'demo', exposed: true }
      })
    ).toBe(true)
    expect(
      isAllowedDaoControlRequest({
        path: '/origin/ea/provider',
        method: 'POST',
        body: { name: 'demo', cfg: { baseUrl: 'https://example.test' } }
      })
    ).toBe(true)
    expect(isAllowedDaoControlRequest({ path: '/origin/ea/config', method: 'GET' })).toBe(false)
    expect(
      isAllowedDaoControlRequest({ path: 'http://169.254.169.254/latest', method: 'GET' })
    ).toBe(false)
    expect(
      isAllowedDaoControlRequest({ path: '/origin/ea/overview', method: 'GET', body: {} })
    ).toBe(false)
  })

  it('keeps requests on the active loopback origin', () => {
    expect(controlRequestUrl('http://127.0.0.1:8955', '/origin/ea/overview')).toBe(
      'http://127.0.0.1:8955/origin/ea/overview'
    )
    expect(controlRequestUrl('http://localhost:8955', '/origin/ea/overview')).toBe(null)
    expect(controlRequestUrl('http://127.0.0.1:8955', 'https://evil.test/')).toBe(null)
  })

  it('only resolves a local bearer key for task reads', async () => {
    expect(requiresDaoTaskAuthorization('/origin/tasks')).toBe(true)
    expect(requiresDaoTaskAuthorization('/origin/tasks/job-1')).toBe(true)
    expect(requiresDaoTaskAuthorization('/origin/ea/overview')).toBe(false)
    expect(requiresDaoTaskAuthorization('https://evil.test/origin/tasks')).toBe(false)

    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ apiKey: 'dao-local-test' }), { status: 200 })
    )
    await expect(readDaoLocalApiKey('http://127.0.0.1:8955', fetchImpl)).resolves.toBe(
      'dao-local-test'
    )
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://127.0.0.1:8955/origin/revproxy/status',
      expect.objectContaining({ headers: { accept: 'application/json' } })
    )
  })

  it('parses JSON and markdown responses without losing status', async () => {
    const json = await readDaoControlResponse(
      new Response(JSON.stringify({ ok: true, value: 1 }), { status: 200 })
    )
    expect(json).toEqual({ ok: true, status: 200, data: { ok: true, value: 1 } })
    const markdown = await readDaoControlResponse(new Response('# handoff', { status: 200 }))
    expect(markdown.data).toBe('# handoff')
  })
})
