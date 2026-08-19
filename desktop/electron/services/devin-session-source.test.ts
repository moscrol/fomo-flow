import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { createDevinSessionSource, projectDevinSession } from './devin-session-source'

const NOW = 1_786_435_900_000
const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true }))
  )
})

function liveStatus(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    key: 'dao:raw-secret-session-id',
    identity: { id: 'raw-secret-session-id', kind: 'native' },
    activation: { state: 'active' },
    activity: {
      lastRequestAt: NOW - 1_000,
      lastUpdateAt: NOW - 2_000,
      requestInFlight: true
    },
    updatedAt: NOW - 500,
    goal: 'Authorization: Basic secret /Users/alice/private/system-prompt.md',
    environment: { cwd: '/Users/alice/private' },
    phase: 'verified',
    route: {
      modelUid: 'swe-1-6-slow',
      provider: 'dp',
      upstreamModel: 'deepseek-v4-flash',
      provisional: false
    },
    ...overrides
  }
}

describe('Devin session source', () => {
  it('projects only a fresh safe route fact and hashes the private session identity', () => {
    const session = projectDevinSession(liveStatus(), NOW)
    const expectedId = createHash('sha256')
      .update('dao:raw-secret-session-id', 'utf8')
      .digest('hex')
      .slice(0, 12)

    expect(session).toMatchObject({
      id: expectedId,
      surface: 'devin',
      identityKind: 'native',
      activation: 'active',
      active: true,
      requestInFlight: true,
      latestActivityAt: NOW - 500,
      phase: 'verified',
      route: {
        modelUid: 'swe-1-6-slow',
        provider: 'dp',
        upstreamModel: 'deepseek-v4-flash',
        provisional: false
      }
    })
    const serialized = JSON.stringify(session)
    expect(serialized).not.toContain('raw-secret-session-id')
    expect(serialized).not.toContain('Authorization')
    expect(serialized).not.toContain('/Users/alice')
    expect(serialized).not.toContain('system-prompt')
  })

  it('rejects terminal, older-than-five-minutes and identity-free session facts', () => {
    expect(
      projectDevinSession(
        liveStatus({ activation: { state: 'stopped' }, updatedAt: NOW - 1_000 }),
        NOW
      )
    ).toBeNull()
    expect(
      projectDevinSession(
        liveStatus({
          updatedAt: NOW - 5 * 60_000 - 1,
          activity: { lastRequestAt: 0, lastUpdateAt: 0, requestInFlight: true }
        }),
        NOW
      )
    ).toBeNull()
    expect(projectDevinSession({ ...liveStatus(), key: '' }, NOW)).toBeNull()
  })

  it('loads bounded JSON files from only the configured local directory', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dao-devin-session-source-'))
    temporaryDirectories.push(directory)
    await writeFile(join(directory, 'fresh.json'), JSON.stringify(liveStatus()), 'utf8')
    await writeFile(join(directory, 'malformed.json'), '{', 'utf8')
    await writeFile(
      join(directory, 'oversized.json'),
      JSON.stringify({ ...liveStatus(), padding: 'x'.repeat(256 * 1024) }),
      'utf8'
    )
    await writeFile(join(directory, 'ignored.txt'), JSON.stringify(liveStatus()), 'utf8')

    const source = createDevinSessionSource({ statusDirectory: directory, now: () => NOW })

    await expect(source.sessions()).resolves.toEqual([
      expect.objectContaining({
        surface: 'devin',
        route: expect.objectContaining({ upstreamModel: 'deepseek-v4-flash' })
      })
    ])
  })
})
