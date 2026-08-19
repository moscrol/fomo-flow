import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  buildChannelMigrationFingerprint,
  matchesChannelMigrationReload,
  type ChannelMigrationReloadSnapshot
} from './channel-migration'

const temporaryRoots: string[] = []

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { force: true, recursive: true })
})

describe('Dao channel migration runtime fingerprint', () => {
  it('distinguishes same-count stale content through the real runtime overview chain', () => {
    const root = mkdtempSync(join(tmpdir(), 'dao-migration-runtime-'))
    temporaryRoots.push(root)
    const configPath = join(root, '配置.json')
    const stateDir = join(root, 'runtime')
    const firstConfig = {
      gateway: { host: '127.0.0.1', port: 11435 },
      providers: { source: { baseUrl: 'https://example.invalid', apiKey: 'fake-key' } },
      customModels: { modelA: { channels: [{ provider: 'source' }] } },
      daoRoutes: {
        enabled: true,
        routes: {
          _注: 'not a runtime route',
          modelA: { provider: 'source', model: 'upstream-a' }
        }
      }
    }
    const secondConfig = structuredClone(firstConfig)
    secondConfig.daoRoutes.routes.modelA.model = 'upstream-b'
    const runtimePath = resolve(process.cwd(), '../vendor/外接api/runtime.js')
    const originPath = resolve(process.cwd(), '../vendor/bundled-origin/source.js')
    const childScript = String.raw`
      const runtime = require(process.argv[1])
      runtime.configure({ configPath: process.argv[3] })
      const origin = require(process.argv[2])
      ;(async () => {
        const started = await origin.start({ host: '127.0.0.1', port: 0, profile: 'desktop', stateDir: process.argv[4] })
        const base = 'http://127.0.0.1:' + started.port
        const snapshot = async () => {
          const [providers, overview] = await Promise.all([
            fetch(base + '/origin/ea/providers').then((response) => response.json()),
            fetch(base + '/origin/ea/overview').then((response) => response.json())
          ])
          return {
            providerCount: Object.keys(providers.providers || {}).length,
            customModelCount: Object.keys(overview.custom_models || {}).length,
            routeCount: Object.keys(overview.routes || {}).length,
            configFingerprint: String(overview.config_fingerprint || '')
          }
        }
        const current = await snapshot()
        await origin.stop()
        process.stdout.write('\nDAO_MIGRATION_SNAPSHOT:' + JSON.stringify(current))
        process.exit(0)
      })().catch((error) => {
        process.stderr.write(error.message)
        process.exit(1)
      })
    `
    const marker = 'DAO_MIGRATION_SNAPSHOT:'
    const snapshot = (config: typeof firstConfig): ChannelMigrationReloadSnapshot => {
      writeFileSync(configPath, JSON.stringify(config), { encoding: 'utf8', mode: 0o600 })
      const output = execFileSync(
        process.execPath,
        ['-e', childScript, runtimePath, originPath, configPath, stateDir],
        { encoding: 'utf8', timeout: 15_000 }
      )
      return JSON.parse(
        output.slice(output.lastIndexOf(marker) + marker.length)
      ) as ChannelMigrationReloadSnapshot
    }
    const stale = snapshot(firstConfig)
    const current = snapshot(secondConfig)
    const expected = {
      providerCount: 1,
      customModelCount: 1,
      routeCount: 1,
      configFingerprint: buildChannelMigrationFingerprint(secondConfig)
    }

    expect(matchesChannelMigrationReload(expected, stale)).toBe(false)
    expect(current).toEqual(expected)
    expect(matchesChannelMigrationReload(expected, current)).toBe(true)
  })
})
