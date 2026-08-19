import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { createWorkAttentionLedger } from './work-attention-ledger'

const NOW = Date.UTC(2026, 7, 10, 5, 0, 0)
const FIRST = '0123456789abcdef0123456789abcdef'
const SECOND = 'fedcba9876543210fedcba9876543210'
const created: string[] = []

async function temporaryUserData(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dao-work-ledger-'))
  created.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(created.splice(0).map((directory) => rm(directory, { recursive: true })))
})

describe('work attention ledger', () => {
  it('stores only a SHA-256 digest and returns matching renderer fingerprints', async () => {
    const userDataDir = await temporaryUserData()
    const ledger = createWorkAttentionLedger({ userDataDir, now: () => NOW })

    await ledger.resolve(FIRST, 'acknowledged')

    expect(await ledger.resolved([FIRST, SECOND])).toEqual([FIRST])
    const serialized = await readFile(join(userDataDir, 'work-attention-ledger.json'), 'utf8')
    const persisted = JSON.parse(serialized) as {
      version: number
      entries: Array<{ fingerprint: string; resolution: string; resolvedAt: number }>
    }
    expect(persisted.version).toBe(1)
    expect(persisted.entries).toHaveLength(1)
    expect(persisted.entries[0]).toMatchObject({
      fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      resolution: 'acknowledged',
      resolvedAt: NOW
    })
    expect(serialized).not.toContain(FIRST)
    expect((await readdir(userDataDir)).some((name) => name.endsWith('.tmp'))).toBe(false)
  })

  it('stores a bounded Taskboard identifier for promoted work', async () => {
    const userDataDir = await temporaryUserData()
    const ledger = createWorkAttentionLedger({ userDataDir, now: () => NOW })

    await ledger.resolve(FIRST, 'promoted', 'DAOFLOW-123')

    const serialized = await readFile(join(userDataDir, 'work-attention-ledger.json'), 'utf8')
    expect(serialized).toContain('DAOFLOW-123')
    expect(serialized).not.toContain(FIRST)
    await expect(ledger.resolve(SECOND, 'promoted', '../private/path')).rejects.toThrow(
      'task identifier'
    )
  })

  it('prunes expired entries and keeps the newest 2,000 records', async () => {
    const userDataDir = await temporaryUserData()
    const ledgerPath = join(userDataDir, 'work-attention-ledger.json')
    const entries = Array.from({ length: 2_002 }, (_, index) => ({
      fingerprint: index.toString(16).padStart(64, '0'),
      resolution: 'acknowledged',
      resolvedAt: NOW - index
    }))
    entries.push({
      fingerprint: 'f'.repeat(64),
      resolution: 'acknowledged',
      resolvedAt: NOW - 91 * 24 * 60 * 60 * 1_000
    })
    await writeFile(ledgerPath, JSON.stringify({ version: 1, entries }))
    const ledger = createWorkAttentionLedger({ userDataDir, now: () => NOW })

    await ledger.resolve(FIRST, 'acknowledged')

    const persisted = JSON.parse(await readFile(ledgerPath, 'utf8')) as {
      entries: Array<{ fingerprint: string; resolvedAt: number }>
    }
    expect(persisted.entries).toHaveLength(2_000)
    expect(persisted.entries.every((entry) => NOW - entry.resolvedAt <= 90 * 86_400_000)).toBe(true)
  })

  it('backs up corrupt storage and starts with an empty ledger', async () => {
    const userDataDir = await temporaryUserData()
    await writeFile(join(userDataDir, 'work-attention-ledger.json'), '{not-json')
    const ledger = createWorkAttentionLedger({ userDataDir, now: () => NOW })

    expect(await ledger.resolved([FIRST])).toEqual([])

    expect(await readdir(userDataDir)).toContain(`work-attention-ledger.corrupt-${NOW}.json`)
    await ledger.resolve(FIRST, 'acknowledged')
    expect(await ledger.resolved([FIRST])).toEqual([FIRST])
  })

  it('rejects malformed fingerprints and extra Taskboard attribution text', async () => {
    const userDataDir = await temporaryUserData()
    const ledger = createWorkAttentionLedger({ userDataDir, now: () => NOW })

    await expect(ledger.resolve('private-job-id', 'acknowledged')).rejects.toThrow('fingerprint')
    await expect(ledger.resolve(FIRST, 'promoted', 'DAOFLOW-123 prompt')).rejects.toThrow(
      'task identifier'
    )
  })
})
