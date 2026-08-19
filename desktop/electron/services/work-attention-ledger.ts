import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export type WorkResolution = 'acknowledged' | 'promoted'

export type WorkAttentionLedger = {
  resolved(fingerprints: string[]): Promise<string[]>
  resolve(fingerprint: string, resolution: WorkResolution, taskIdentifier?: string): Promise<void>
}

type StoredEntry = {
  fingerprint: string
  resolution: WorkResolution
  resolvedAt: number
  taskIdentifier?: string
}

type StoredLedger = {
  version: 1
  entries: StoredEntry[]
}

const FINGERPRINT = /^[a-f0-9]{32,128}$/
const STORED_FINGERPRINT = /^[a-f0-9]{64}$/
const TASK_IDENTIFIER = /^[A-Z][A-Z0-9]{1,30}-[1-9][0-9]{0,11}$/
const RETENTION_MS = 90 * 24 * 60 * 60 * 1_000
const MAX_ENTRIES = 2_000

function digest(fingerprint: string): string {
  return createHash('sha256').update(fingerprint, 'utf8').digest('hex')
}

function validStoredEntry(value: unknown): value is StoredEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const entry = value as Record<string, unknown>
  return (
    typeof entry.fingerprint === 'string' &&
    STORED_FINGERPRINT.test(entry.fingerprint) &&
    (entry.resolution === 'acknowledged' || entry.resolution === 'promoted') &&
    typeof entry.resolvedAt === 'number' &&
    Number.isFinite(entry.resolvedAt) &&
    (entry.taskIdentifier === undefined ||
      (typeof entry.taskIdentifier === 'string' && TASK_IDENTIFIER.test(entry.taskIdentifier)))
  )
}

function prune(entries: StoredEntry[], now: number): StoredEntry[] {
  const newest = new Map<string, StoredEntry>()
  for (const entry of entries) {
    if (!validStoredEntry(entry) || now - entry.resolvedAt > RETENTION_MS) continue
    const existing = newest.get(entry.fingerprint)
    if (!existing || entry.resolvedAt > existing.resolvedAt) newest.set(entry.fingerprint, entry)
  }
  return [...newest.values()]
    .sort((left, right) => right.resolvedAt - left.resolvedAt)
    .slice(0, MAX_ENTRIES)
}

export function createWorkAttentionLedger({
  userDataDir,
  now = Date.now
}: {
  userDataDir: string
  now?: () => number
}): WorkAttentionLedger {
  const ledgerPath = join(userDataDir, 'work-attention-ledger.json')
  let entries: StoredEntry[] = []
  let initialized = false
  let writeQueue: Promise<void> = Promise.resolve()

  async function load(): Promise<void> {
    if (initialized) return
    initialized = true
    try {
      const parsed = JSON.parse(await readFile(ledgerPath, 'utf8')) as Partial<StoredLedger>
      if (parsed.version !== 1 || !Array.isArray(parsed.entries)) throw new Error('invalid ledger')
      entries = prune(parsed.entries.filter(validStoredEntry), now())
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? String(error.code) : ''
      entries = []
      if (code === 'ENOENT') return
      await mkdir(userDataDir, { recursive: true })
      await rename(
        ledgerPath,
        join(userDataDir, `work-attention-ledger.corrupt-${now()}.json`)
      ).catch(() => undefined)
    }
  }

  async function persist(): Promise<void> {
    await mkdir(userDataDir, { recursive: true })
    const temporaryPath = `${ledgerPath}.${process.pid}.tmp`
    const content = JSON.stringify({ version: 1, entries } satisfies StoredLedger)
    await writeFile(temporaryPath, content, { encoding: 'utf8', mode: 0o600 })
    await rename(temporaryPath, ledgerPath)
  }

  return {
    async resolved(fingerprints) {
      if (fingerprints.length > 200 || fingerprints.some((value) => !FINGERPRINT.test(value))) {
        throw new Error('Invalid work fingerprint list')
      }
      await writeQueue
      await load()
      const stored = new Set(entries.map((entry) => entry.fingerprint))
      return fingerprints.filter((fingerprint) => stored.has(digest(fingerprint)))
    },

    async resolve(fingerprint, resolution, taskIdentifier) {
      if (!FINGERPRINT.test(fingerprint)) throw new Error('Invalid work fingerprint')
      if (resolution !== 'acknowledged' && resolution !== 'promoted') {
        throw new Error('Invalid work resolution')
      }
      if (resolution === 'promoted' && (!taskIdentifier || !TASK_IDENTIFIER.test(taskIdentifier))) {
        throw new Error('Invalid task identifier')
      }
      if (resolution === 'acknowledged' && taskIdentifier !== undefined) {
        throw new Error('Invalid task identifier')
      }

      const write = async () => {
        await load()
        const resolvedAt = now()
        entries = prune(
          [
            ...entries,
            {
              fingerprint: digest(fingerprint),
              resolution,
              resolvedAt,
              ...(taskIdentifier ? { taskIdentifier } : {})
            }
          ],
          resolvedAt
        )
        await persist()
      }
      writeQueue = writeQueue.then(write, write)
      await writeQueue
    }
  }
}
