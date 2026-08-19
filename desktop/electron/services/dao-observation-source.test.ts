import { describe, expect, it, vi } from 'vitest'

import { createDaoObservationSource, parseObservationDescriptor } from './dao-observation-source'

const DESKTOP = 'http://127.0.0.1:54500'
const LEGACY = 'http://127.0.0.1:8955'

function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

describe('Dao observation source', () => {
  it('accepts only exact loopback endpoint descriptors', () => {
    expect(parseObservationDescriptor({ base: LEGACY, host: '127.0.0.1', port: 8955 })).toBe(LEGACY)
    expect(
      parseObservationDescriptor({
        base: 'http://localhost:8955',
        host: 'localhost',
        port: 8955
      })
    ).toBeNull()
    expect(
      parseObservationDescriptor({
        base: 'http://127.0.0.1:8955/path?token=secret',
        host: '127.0.0.1',
        port: 8955
      })
    ).toBeNull()
  })

  it('returns the local HUD that has the newest real IDE activity', async () => {
    const readFile = vi.fn(async () =>
      JSON.stringify({ base: LEGACY, host: '127.0.0.1', port: 8955 })
    )
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.endsWith('/origin/health')) {
        const port = url.startsWith(LEGACY) ? 8955 : 54500
        return response({ ok: true, dao_loaded: true, port })
      }
      if (url.startsWith(LEGACY)) {
        return response({
          version: 1,
          generatedAt: 2_000,
          runtime: { port: 8955 },
          sessions: [
            {
              surface: 'devin',
              active: true,
              latestActivityAt: 1_900,
              cache: { observed: true }
            }
          ],
          recentRequests: [{ at: 1_950, cacheStatus: 'hit' }]
        })
      }
      return response({
        version: 1,
        generatedAt: 2_100,
        runtime: { port: 54500 },
        sessions: [{ surface: 'codex', active: false, latestActivityAt: 1_000 }],
        recentRequests: []
      })
    })
    const source = createDaoObservationSource({
      getDesktopUrl: () => DESKTOP,
      descriptorPaths: ['/fixed/legacy/endpoint.json'],
      readFile,
      fetchImpl
    })

    const selected = await source.snapshot()

    expect(selected).toMatchObject({ runtime: { port: 8955 } })
    expect(readFile).toHaveBeenCalledWith('/fixed/legacy/endpoint.json', 'utf8')
    expect(fetchImpl.mock.calls.map(([url]) => String(url))).toEqual([
      `${DESKTOP}/origin/health`,
      `${DESKTOP}/origin/hud/snapshot`,
      `${LEGACY}/origin/health`,
      `${LEGACY}/origin/hud/snapshot`
    ])
  })

  it('prefers Desktop when its evidence becomes newer and falls back safely', async () => {
    let legacyAvailable = true
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.startsWith(LEGACY) && !legacyAvailable) return response({}, 503)
      if (url.endsWith('/origin/health')) {
        const port = url.startsWith(LEGACY) ? 8955 : 54500
        return response({ ok: true, dao_loaded: true, port })
      }
      return response({
        version: 1,
        runtime: { port: url.startsWith(LEGACY) ? 8955 : 54500 },
        sessions: [],
        recentRequests: [{ at: url.startsWith(DESKTOP) ? 3_000 : 2_000 }]
      })
    })
    const source = createDaoObservationSource({
      getDesktopUrl: () => DESKTOP,
      descriptorPaths: ['/fixed/legacy/endpoint.json'],
      readFile: async () => JSON.stringify({ base: LEGACY, host: '127.0.0.1', port: 8955 }),
      fetchImpl
    })

    await expect(source.snapshot()).resolves.toMatchObject({ runtime: { port: 54500 } })
    legacyAvailable = false
    await expect(source.snapshot()).resolves.toMatchObject({ runtime: { port: 54500 } })
  })

  it('uses snapshot generation time to break equal real-activity ties', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.endsWith('/origin/health')) {
        return response({
          ok: true,
          dao_loaded: true,
          port: url.startsWith(LEGACY) ? 8955 : 54500
        })
      }
      return response({
        version: 1,
        generatedAt: url.startsWith(DESKTOP) ? 4_000 : 3_000,
        runtime: { port: url.startsWith(LEGACY) ? 8955 : 54500 },
        sessions: [],
        recentRequests: [{ at: 2_000 }]
      })
    })
    const source = createDaoObservationSource({
      getDesktopUrl: () => DESKTOP,
      descriptorPaths: ['/fixed/legacy/endpoint.json'],
      readFile: async () => JSON.stringify({ base: LEGACY, host: '127.0.0.1', port: 8955 }),
      fetchImpl
    })

    await expect(source.snapshot()).resolves.toMatchObject({ runtime: { port: 54500 } })
  })

  it('reads an exact runtime fact from the selected live source', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.endsWith('/origin/health')) {
        const port = url.startsWith(LEGACY) ? 8955 : 54500
        return response({ ok: true, dao_loaded: true, port })
      }
      if (url.endsWith('/origin/hud/snapshot')) {
        return response({
          version: 1,
          runtime: { port: url.startsWith(LEGACY) ? 8955 : 54500 },
          sessions: [],
          recentRequests: url.startsWith(LEGACY) ? [{ at: 9_000 }] : []
        })
      }
      if (url === `${LEGACY}/origin/ea/usage`) {
        return response({ totals: { calls: 36, hitRate: 58.1 } })
      }
      return response({}, 404)
    })
    const source = createDaoObservationSource({
      getDesktopUrl: () => DESKTOP,
      descriptorPaths: ['/fixed/legacy/endpoint.json'],
      readFile: async () => JSON.stringify({ base: LEGACY, host: '127.0.0.1', port: 8955 }),
      fetchImpl
    })

    await expect(source.request('/origin/ea/usage')).resolves.toEqual({
      totals: { calls: 36, hitRate: 58.1 }
    })
    await expect(source.request('/origin/ea/audit')).rejects.toThrow(
      'Dao observation path is not permitted'
    )
    await expect(source.request('/origin/ea/usage?token=secret')).rejects.toThrow(
      'Dao observation path is not permitted'
    )
  })

  it('reads tasks from the selected live source with a main-only bearer', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/origin/health')) {
        return response({
          ok: true,
          dao_loaded: true,
          port: url.startsWith(LEGACY) ? 8955 : 54500
        })
      }
      if (url.endsWith('/origin/hud/snapshot')) {
        return response({
          version: 1,
          runtime: { port: url.startsWith(LEGACY) ? 8955 : 54500 },
          sessions: [],
          recentRequests: url.startsWith(LEGACY) ? [{ at: 9_000 }] : []
        })
      }
      if (url === `${LEGACY}/origin/tasks`) {
        expect(new Headers(init?.headers).get('authorization')).toBe('Bearer dao-main-only')
        return response({ ok: true, tasks: [{ jobId: 'private-task', status: 'running' }] })
      }
      return response({}, 404)
    })
    const getLocalApiKey = vi.fn(async (base: string) => (base === LEGACY ? 'dao-main-only' : null))
    const source = createDaoObservationSource({
      getDesktopUrl: () => DESKTOP,
      descriptorPaths: ['/fixed/legacy/endpoint.json'],
      readFile: async () => JSON.stringify({ base: LEGACY, host: '127.0.0.1', port: 8955 }),
      fetchImpl,
      getLocalApiKey
    })

    await expect(source.request('/origin/tasks')).resolves.toEqual({
      ok: true,
      tasks: [{ jobId: 'private-task', status: 'running' }]
    })
    expect(getLocalApiKey).toHaveBeenCalledWith(LEGACY)
    expect(fetchImpl).toHaveBeenLastCalledWith(
      `${LEGACY}/origin/tasks`,
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer dao-main-only' })
      })
    )
  })

  it('retires stale sessions even when an older runtime keeps active flags pinned', async () => {
    const generatedAt = 2_000_000
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.endsWith('/origin/health')) {
        return response({ ok: true, dao_loaded: true, port: 54500 })
      }
      return response({
        version: 1,
        generatedAt,
        runtime: { port: 54500 },
        totals: { activeSessions: 4, warnings: 1 },
        sessions: [
          {
            id: 'fresh',
            goal: 'These memories were automatically retrieved from previous conversations and may or may not be relevant.',
            activation: 'active',
            active: false,
            lifecycle: 'stale',
            stale: true,
            requestInFlight: false,
            latestActivityAt: generatedAt - 5 * 60_000
          },
          {
            id: 'attention',
            activation: 'active',
            active: true,
            lifecycle: 'active',
            requestInFlight: true,
            latestActivityAt: generatedAt - 12 * 60_000
          },
          {
            id: 'five-minute-retire',
            activation: 'active',
            active: true,
            lifecycle: 'active',
            requestInFlight: true,
            latestActivityAt: generatedAt - 6 * 60_000
          },
          {
            id: 'retired',
            activation: 'active',
            active: true,
            lifecycle: 'active',
            requestInFlight: true,
            latestActivityAt: generatedAt - 16 * 60_000
          },
          { id: 'unknown-time', activation: 'active', active: true }
        ],
        recentRequests: []
      })
    })
    const source = createDaoObservationSource({
      getDesktopUrl: () => DESKTOP,
      descriptorPaths: [],
      fetchImpl
    })

    const selected = await source.snapshot()

    expect(selected.sessions).toEqual([
      expect.objectContaining({ id: 'fresh', goal: '', active: true, lifecycle: 'active' }),
      expect.objectContaining({
        id: 'attention',
        active: false,
        lifecycle: 'stale',
        requestInFlight: false
      }),
      expect.objectContaining({
        id: 'five-minute-retire',
        active: false,
        lifecycle: 'stale',
        requestInFlight: false
      })
    ])
    expect(selected.totals).toMatchObject({ activeSessions: 1, warnings: 3 })
  })

  it('does not expose continuation wrappers as session goals', async () => {
    const generatedAt = 2_100_000
    const source = createDaoObservationSource({
      getDesktopUrl: () => DESKTOP,
      descriptorPaths: [],
      fetchImpl: async (input: string | URL | Request) => {
        const url = String(input)
        if (url.endsWith('/origin/health')) {
          return response({ ok: true, dao_loaded: true, port: 54500 })
        }
        return response({
          version: 1,
          generatedAt,
          runtime: { port: 54500 },
          sessions: [
            {
              id: 'continuation-wrapper',
              surface: 'devin',
              active: true,
              lifecycle: 'active',
              latestActivityAt: generatedAt - 1_000,
              goal: 'You are continuing work from a previous conversation thread. Below is a summary of the previous conversation thread:'
            }
          ],
          recentRequests: []
        })
      }
    })

    const selected = await source.snapshot()

    expect(selected).toMatchObject({
      sessions: [expect.objectContaining({ goal: '' })]
    })
  })

  it('merges fresh main-only Devin route facts without discarding HUD cache telemetry', async () => {
    const generatedAt = 1_786_435_900_000
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.endsWith('/origin/health')) {
        return response({ ok: true, dao_loaded: true, port: 54500 })
      }
      return response({
        version: 1,
        generatedAt,
        runtime: { port: 54500 },
        totals: { activeSessions: 1, warnings: 0 },
        sessions: [
          {
            id: 'same-safe-id',
            surface: 'devin',
            activation: 'active',
            active: true,
            latestActivityAt: generatedAt - 20_000,
            route: {
              modelUid: 'old-route',
              provider: 'old-provider',
              upstreamModel: 'old-model',
              provisional: false
            },
            cache: { observed: true, calls: 7, hitRate: 42 },
            telemetry: { reasoningTokens: 88 }
          }
        ],
        recentRequests: []
      })
    })
    const getDevinSessions = vi.fn(async () => [
      {
        id: 'same-safe-id',
        surface: 'devin',
        activation: 'active',
        active: true,
        lifecycle: 'active',
        stale: false,
        warning: false,
        requestInFlight: true,
        latestActivityAt: generatedAt - 1_000,
        route: {
          modelUid: 'swe-1-6-slow',
          provider: 'dp',
          upstreamModel: 'deepseek-v4-flash',
          provisional: false
        }
      },
      {
        id: 'recovered-safe-id',
        surface: 'devin',
        activation: 'active',
        active: true,
        lifecycle: 'active',
        stale: false,
        warning: false,
        requestInFlight: true,
        latestActivityAt: generatedAt - 2_000,
        route: {
          modelUid: 'dao-opus-5',
          provider: 'cc',
          upstreamModel: 'claude-opus-5',
          provisional: false
        }
      }
    ])
    const source = createDaoObservationSource({
      getDesktopUrl: () => DESKTOP,
      descriptorPaths: [],
      fetchImpl,
      getDevinSessions
    })

    const selected = await source.snapshot()

    expect(getDevinSessions).toHaveBeenCalledTimes(1)
    expect(selected.sessions).toHaveLength(2)
    expect(selected.sessions).toContainEqual(
      expect.objectContaining({
        id: 'same-safe-id',
        latestActivityAt: generatedAt - 1_000,
        route: expect.objectContaining({
          modelUid: 'swe-1-6-slow',
          provider: 'dp',
          upstreamModel: 'deepseek-v4-flash'
        }),
        cache: { observed: true, calls: 7, hitRate: 42 },
        telemetry: { reasoningTokens: 88 }
      })
    )
    expect(selected.sessions).toContainEqual(
      expect.objectContaining({ id: 'recovered-safe-id', active: true })
    )
    expect(selected.totals).toMatchObject({ activeSessions: 2 })
  })

  it('keeps the selected HUD usable when the optional Devin fact source fails', async () => {
    const source = createDaoObservationSource({
      getDesktopUrl: () => DESKTOP,
      descriptorPaths: [],
      fetchImpl: async (input: string | URL | Request) => {
        if (String(input).endsWith('/origin/health')) {
          return response({ ok: true, dao_loaded: true, port: 54500 })
        }
        return response({
          version: 1,
          generatedAt: 10_000,
          runtime: { port: 54500 },
          totals: { activeSessions: 0 },
          sessions: [],
          recentRequests: []
        })
      },
      getDevinSessions: async () => {
        throw new Error('optional local source unavailable')
      }
    })

    await expect(source.snapshot()).resolves.toMatchObject({ runtime: { port: 54500 } })
  })

  it('stops reading an observation response after the byte limit', async () => {
    let cancelled = false
    const oversized = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let index = 0; index < 9; index += 1) {
          controller.enqueue(new Uint8Array(1024 * 1024))
        }
      },
      cancel() {
        cancelled = true
      }
    })
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.endsWith('/origin/health')) {
        return response({ ok: true, dao_loaded: true, port: 54500 })
      }
      if (url.endsWith('/origin/hud/snapshot')) {
        return response({ version: 1, generatedAt: 1, sessions: [], recentRequests: [] })
      }
      return new Response(oversized, { status: 200 })
    })
    const source = createDaoObservationSource({
      getDesktopUrl: () => DESKTOP,
      descriptorPaths: [],
      fetchImpl
    })

    await expect(source.request('/origin/ea/usage')).rejects.toThrow(
      'Dao observation response is too large'
    )
    expect(cancelled).toBe(true)
  })
})
