import {
  copyFile,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  unlink,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  buildChannelMigrationFingerprint,
  buildSafeChannelMigrationPreview,
  createChannelMigrationService,
  matchesChannelMigrationReload,
  mergeDaoChannelConfig
} from './channel-migration'

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true }))
  )
})

async function migrationFixture() {
  const root = await mkdtemp(join(tmpdir(), 'dao-channel-migration-'))
  temporaryRoots.push(root)
  const homeDir = join(root, 'home')
  const userDataDir = join(root, 'user-data')
  const sourcePath = join(homeDir, '.codeium', 'dao-byok', '配置.json')
  const destinationPath = join(userDataDir, 'config', '配置.json')
  await mkdir(join(homeDir, '.codeium', 'dao-byok'), { recursive: true })
  await mkdir(join(userDataDir, 'config'), { recursive: true })
  const source = {
    gateway: { mode: 'legacy' },
    providers: { source: { apiKey: 'source-secret' } },
    customModels: { modelA: { channels: [{ provider: 'source' }] } },
    daoRoutes: { routes: { modelA: { provider: 'source', model: 'upstream-a' } } }
  }
  const target = {
    gateway: { mode: 'desktop' },
    providers: { desktop: {} },
    customModels: {},
    daoRoutes: { routes: {} }
  }
  await writeFile(sourcePath, JSON.stringify(source), 'utf8')
  await writeFile(destinationPath, JSON.stringify(target), 'utf8')
  return { homeDir, userDataDir, sourcePath, destinationPath, source, target }
}

describe('Dao channel migration', () => {
  it('keeps Desktop-only settings while source routing wins without reordering priority', () => {
    const source = {
      gateway: { mode: 'legacy' },
      providers: {
        shared: { baseUrl: 'https://source.invalid', apiKey: 'source-secret' },
        imported: { baseUrl: 'https://imported.invalid', apiKey: 'import-secret' }
      },
      customModels: {
        modelA: {
          channels: [{ provider: 'imported' }, { provider: 'shared' }]
        }
      },
      daoRoutes: {
        enabled: true,
        substituteEnabled: false,
        allowMcpTools: true,
        routes: { modelA: { provider: 'imported', model: 'upstream-a' } }
      },
      sourceOnlyPrivateField: 'must-not-copy'
    }
    const target = {
      gateway: { mode: 'desktop', port: 8955 },
      providers: {
        shared: { baseUrl: 'https://desktop.invalid', apiKey: 'desktop-secret' },
        desktopOnly: { baseUrl: 'https://desktop-only.invalid' }
      },
      customModels: {
        desktopModel: { channels: [{ provider: 'desktopOnly' }] }
      },
      daoRoutes: {
        _说明: 'keep metadata',
        routes: { old: { provider: 'desktopOnly', model: 'old' } }
      },
      desktopOnlyField: { enabled: true }
    }

    const result = mergeDaoChannelConfig(source, target)

    expect(result).toEqual({
      gateway: { mode: 'desktop', port: 8955 },
      providers: {
        shared: { baseUrl: 'https://source.invalid', apiKey: 'source-secret' },
        desktopOnly: { baseUrl: 'https://desktop-only.invalid' },
        imported: { baseUrl: 'https://imported.invalid', apiKey: 'import-secret' }
      },
      customModels: {
        desktopModel: { channels: [{ provider: 'desktopOnly' }] },
        modelA: { channels: [{ provider: 'imported' }, { provider: 'shared' }] }
      },
      daoRoutes: {
        enabled: true,
        substituteEnabled: false,
        allowMcpTools: true,
        routes: { modelA: { provider: 'imported', model: 'upstream-a' } },
        _说明: 'keep metadata'
      },
      desktopOnlyField: { enabled: true }
    })
    expect(source.customModels.modelA.channels.map((channel) => channel.provider)).toEqual([
      'imported',
      'shared'
    ])
  })

  it('summarizes migration counts without exposing paths, credentials, URLs, or raw config', () => {
    const preview = buildSafeChannelMigrationPreview(
      {
        providers: {
          shared: { baseUrl: 'https://secret.invalid', apiKey: 'sk-source' },
          imported: {},
          鸡米花: {},
          'Authorization: Bearer secret': {},
          '/Users/private/provider': {},
          'sk-super-secret-token': {}
        },
        customModels: { modelA: { channels: [{ provider: 'imported' }] } },
        daoRoutes: {
          enabled: true,
          routes: { modelA: { provider: 'imported', model: 'upstream-a' } }
        }
      },
      {
        gateway: { mode: 'desktop' },
        providers: { shared: {}, desktopOnly: {} },
        customModels: {},
        daoRoutes: { routes: {} }
      }
    )

    expect(preview).toEqual({
      available: true,
      sourceLabel: '现有 FOMO FLOW 配置',
      providerNames: ['shared', 'imported', '鸡米花', '未命名渠道'],
      providerCount: 6,
      customModelCount: 1,
      routeCount: 1,
      newProviderCount: 5,
      overwrittenProviderCount: 1,
      preservedDesktopProviderCount: 1,
      priorityPreserved: true,
      message: '找到可迁移的现有 FOMO FLOW 渠道与路由。'
    })
    const rendered = JSON.stringify(preview)
    expect(rendered).not.toContain('sk-source')
    expect(rendered).not.toContain('https://')
    expect(rendered).not.toContain('/Users/')
    expect(rendered).not.toContain('Authorization')
    expect(rendered).not.toContain('Bearer')
    expect(rendered).not.toContain('sk-super-secret-token')
  })

  it('can migrate into a valid fresh Desktop config with no existing providers', async () => {
    const fixture = await migrationFixture()
    const freshTarget = {
      gateway: { mode: 'desktop' },
      providers: {},
      customModels: {},
      daoRoutes: { routes: {} }
    }
    await writeFile(fixture.destinationPath, JSON.stringify(freshTarget), 'utf8')
    const service = createChannelMigrationService({
      homeDir: fixture.homeDir,
      userDataDir: fixture.userDataDir,
      tokenBytes: () => Buffer.alloc(32, 6),
      settleAfterWrite: async () => undefined
    })

    const preview = await service.preview()
    expect(preview).toMatchObject({ available: true, providerCount: 1 })
    await service.apply({ confirmationToken: preview.confirmationToken! })

    const migrated = JSON.parse(await readFile(fixture.destinationPath, 'utf8'))
    expect(migrated.gateway).toEqual(freshTarget.gateway)
    expect(migrated.providers).toEqual(fixture.source.providers)
  })

  it('previews with zero writes then backs up and atomically applies the confirmed migration', async () => {
    const fixture = await migrationFixture()
    const beforePreview = await readFile(fixture.destinationPath, 'utf8')
    const service = createChannelMigrationService({
      homeDir: fixture.homeDir,
      userDataDir: fixture.userDataDir,
      now: () => new Date('2026-08-10T06:00:00.000Z'),
      tokenBytes: () => Buffer.alloc(32, 7),
      tokenTtlMs: 60_000,
      settleAfterWrite: async () => undefined
    })

    const preview = await service.preview()

    expect(preview).toMatchObject({
      available: true,
      providerCount: 1,
      customModelCount: 1,
      routeCount: 1,
      confirmationToken: '07'.repeat(32)
    })
    expect(await readFile(fixture.destinationPath, 'utf8')).toBe(beforePreview)

    const result = await service.apply({ confirmationToken: preview.confirmationToken! })
    const migrated = JSON.parse(await readFile(fixture.destinationPath, 'utf8'))
    const backupDir = join(fixture.userDataDir, 'config', '.config-backups')
    const backups = await readdir(backupDir)

    expect(result).toEqual({
      ok: true,
      providerCount: 1,
      customModelCount: 1,
      routeCount: 1,
      backupCreated: true,
      priorityPreserved: true,
      reloadReflected: true,
      message: '现有 FOMO FLOW 渠道与路由已安全导入。'
    })
    expect(migrated.gateway).toEqual(fixture.target.gateway)
    expect(migrated.providers).toEqual({ desktop: {}, source: { apiKey: 'source-secret' } })
    expect(migrated.customModels).toEqual(fixture.source.customModels)
    expect(migrated.daoRoutes).toEqual(fixture.source.daoRoutes)
    expect(backups).toEqual(['配置.json.2026-08-10T06-00-00-000Z.bak'])
    expect((await stat(fixture.destinationPath)).mode & 0o777).toBe(0o600)
    expect((await stat(backupDir)).mode & 0o777).toBe(0o700)
    expect((await stat(join(backupDir, backups[0]))).mode & 0o777).toBe(0o600)
    const auditPath = join(fixture.userDataDir, 'runtime', 'channel-migration-audit.jsonl')
    const audit = JSON.parse((await readFile(auditPath, 'utf8')).trim())
    expect(audit).toEqual({
      version: 1,
      migratedAt: '2026-08-10T06:00:00.000Z',
      providerCount: 1,
      customModelCount: 1,
      routeCount: 1,
      result: 'success',
      sourceHash: expect.stringMatching(/^[a-f0-9]{16}$/)
    })
    expect(JSON.stringify(audit)).not.toContain('source-secret')
    expect(JSON.stringify(audit)).not.toContain(fixture.sourcePath)
  })

  it('returns a safe unavailable preview when the existing Dao config is missing', async () => {
    const fixture = await migrationFixture()
    await unlink(fixture.sourcePath)
    const beforePreview = await readFile(fixture.destinationPath, 'utf8')
    const service = createChannelMigrationService({
      homeDir: fixture.homeDir,
      userDataDir: fixture.userDataDir
    })

    await expect(service.preview()).resolves.toEqual({
      available: false,
      sourceLabel: '现有 FOMO FLOW 配置',
      providerNames: [],
      providerCount: 0,
      customModelCount: 0,
      routeCount: 0,
      newProviderCount: 0,
      overwrittenProviderCount: 0,
      preservedDesktopProviderCount: 0,
      priorityPreserved: true,
      message: '没有找到现有 FOMO FLOW 配置。'
    })
    expect(await readFile(fixture.destinationPath, 'utf8')).toBe(beforePreview)
  })

  it('returns a safe unavailable preview for invalid source JSON', async () => {
    const fixture = await migrationFixture()
    await writeFile(fixture.sourcePath, '{"providers":', 'utf8')
    const service = createChannelMigrationService({
      homeDir: fixture.homeDir,
      userDataDir: fixture.userDataDir
    })

    const preview = await service.preview()
    expect(preview).toMatchObject({
      available: false,
      message: '现有配置无法安全读取。'
    })
    expect(preview).not.toHaveProperty('confirmationToken')
    expect(JSON.stringify(preview)).not.toContain(fixture.sourcePath)
  })

  it('rejects array-shaped provider and custom-model structures', async () => {
    const fixture = await migrationFixture()
    await writeFile(
      fixture.sourcePath,
      JSON.stringify({ providers: [], customModels: [], daoRoutes: { routes: {} } }),
      'utf8'
    )
    const service = createChannelMigrationService({
      homeDir: fixture.homeDir,
      userDataDir: fixture.userDataDir
    })

    await expect(service.preview()).resolves.toMatchObject({
      available: false,
      message: '现有配置无法安全读取。'
    })
  })

  it('rejects fake, expired, and drifted confirmations without overwriting current config', async () => {
    const fixture = await migrationFixture()
    let currentTime = new Date('2026-08-10T06:00:00.000Z')
    const service = createChannelMigrationService({
      homeDir: fixture.homeDir,
      userDataDir: fixture.userDataDir,
      now: () => currentTime,
      tokenBytes: () => Buffer.alloc(32, 8),
      tokenTtlMs: 1_000,
      settleAfterWrite: async () => undefined
    })

    await expect(service.apply({ confirmationToken: '09'.repeat(32) })).rejects.toThrow(
      '配置已变化，请重新检查'
    )
    const expired = await service.preview()
    currentTime = new Date('2026-08-10T06:00:02.000Z')
    await expect(service.apply({ confirmationToken: expired.confirmationToken! })).rejects.toThrow(
      '配置已变化，请重新检查'
    )

    currentTime = new Date('2026-08-10T06:00:03.000Z')
    const drifted = await service.preview()
    const changedTarget = `${JSON.stringify({ ...fixture.target, desktopChanged: true })}\n`
    await writeFile(fixture.destinationPath, changedTarget, 'utf8')
    await expect(service.apply({ confirmationToken: drifted.confirmationToken! })).rejects.toThrow(
      '配置已变化，请重新检查'
    )
    expect(await readFile(fixture.destinationPath, 'utf8')).toBe(changedTarget)
    await expect(
      readdir(join(fixture.userDataDir, 'config', '.config-backups'))
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('does not report completion until the runtime reload window has settled', async () => {
    const fixture = await migrationFixture()
    let releaseSettle!: () => void
    let markEntered!: () => void
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve
    })
    const settle = new Promise<void>((resolve) => {
      releaseSettle = resolve
    })
    const service = createChannelMigrationService({
      homeDir: fixture.homeDir,
      userDataDir: fixture.userDataDir,
      tokenBytes: () => Buffer.alloc(32, 5),
      settleAfterWrite: async () => {
        markEntered()
        await settle
      }
    })
    const preview = await service.preview()
    let completed = false

    const applying = service.apply({ confirmationToken: preview.confirmationToken! }).then(() => {
      completed = true
    })
    await entered
    expect(completed).toBe(false)

    releaseSettle()
    await applying
    expect(completed).toBe(true)
  })

  it('uses a confirmation token only once', async () => {
    const fixture = await migrationFixture()
    const service = createChannelMigrationService({
      homeDir: fixture.homeDir,
      userDataDir: fixture.userDataDir,
      tokenBytes: () => Buffer.alloc(32, 4),
      settleAfterWrite: async () => undefined
    })
    const preview = await service.preview()
    const confirmation = { confirmationToken: preview.confirmationToken! }

    await expect(service.apply(confirmation)).resolves.toMatchObject({ ok: true })
    await expect(service.apply(confirmation)).rejects.toThrow('配置已变化，请重新检查')
  })

  it('keeps the target unchanged and hides raw details when backup creation fails', async () => {
    const fixture = await migrationFixture()
    const before = await readFile(fixture.destinationPath, 'utf8')
    const service = createChannelMigrationService({
      homeDir: fixture.homeDir,
      userDataDir: fixture.userDataDir,
      tokenBytes: () => Buffer.alloc(32, 3),
      copyDestination: async () => {
        throw new Error(`EACCES ${fixture.destinationPath} Authorization: secret`)
      },
      settleAfterWrite: async () => undefined
    })
    const preview = await service.preview()

    await expect(service.apply({ confirmationToken: preview.confirmationToken! })).rejects.toThrow(
      '配置备份失败，请检查本机存储后重试'
    )
    expect(await readFile(fixture.destinationPath, 'utf8')).toBe(before)
  })

  it('keeps the target unchanged and hides raw details when atomic writing fails', async () => {
    const fixture = await migrationFixture()
    const before = await readFile(fixture.destinationPath, 'utf8')
    const service = createChannelMigrationService({
      homeDir: fixture.homeDir,
      userDataDir: fixture.userDataDir,
      tokenBytes: () => Buffer.alloc(32, 2),
      writeDestination: async () => {
        throw new Error(`EIO /private/配置.json apiKey=secret`)
      },
      settleAfterWrite: async () => undefined
    })
    const preview = await service.preview()

    await expect(service.apply({ confirmationToken: preview.confirmationToken! })).rejects.toThrow(
      '配置写入失败，旧配置已保留'
    )
    expect(await readFile(fixture.destinationPath, 'utf8')).toBe(before)
  })

  it('reports a safe success when only the audit append fails after migration', async () => {
    const fixture = await migrationFixture()
    const service = createChannelMigrationService({
      homeDir: fixture.homeDir,
      userDataDir: fixture.userDataDir,
      tokenBytes: () => Buffer.alloc(32, 1),
      appendAudit: async () => {
        throw new Error(`EACCES ${fixture.sourcePath} Bearer secret`)
      },
      settleAfterWrite: async () => undefined
    })
    const preview = await service.preview()

    await expect(
      service.apply({ confirmationToken: preview.confirmationToken! })
    ).resolves.toMatchObject({
      ok: true,
      message: '现有 FOMO FLOW 渠道与路由已导入，但审计记录暂不可用。'
    })
    const migrated = JSON.parse(await readFile(fixture.destinationPath, 'utf8'))
    expect(migrated.providers.source).toEqual(fixture.source.providers.source)
  })

  it('rejects drift that occurs while the backup is being created', async () => {
    const fixture = await migrationFixture()
    const changedTarget = `${JSON.stringify({ ...fixture.target, changedDuringBackup: true })}\n`
    const service = createChannelMigrationService({
      homeDir: fixture.homeDir,
      userDataDir: fixture.userDataDir,
      tokenBytes: () => Buffer.alloc(32, 10),
      copyDestination: async (source, destination) => {
        await copyFile(source, destination)
        await writeFile(fixture.destinationPath, changedTarget, 'utf8')
      },
      settleAfterWrite: async () => undefined
    })
    const preview = await service.preview()

    await expect(service.apply({ confirmationToken: preview.confirmationToken! })).rejects.toThrow(
      '配置已变化，请重新检查'
    )
    expect(await readFile(fixture.destinationPath, 'utf8')).toBe(changedTarget)
  })

  it('rejects concurrent applies even when they use different confirmation tokens', async () => {
    const fixture = await migrationFixture()
    let tokenSeed = 11
    let copyCount = 0
    let releaseFirst!: () => void
    let markFirstEntered!: () => void
    const firstEntered = new Promise<void>((resolve) => {
      markFirstEntered = resolve
    })
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const service = createChannelMigrationService({
      homeDir: fixture.homeDir,
      userDataDir: fixture.userDataDir,
      tokenBytes: () => Buffer.alloc(32, tokenSeed++),
      copyDestination: async (source, destination) => {
        await copyFile(source, destination)
        copyCount += 1
        if (copyCount === 1) {
          markFirstEntered()
          await firstGate
        }
      },
      settleAfterWrite: async () => undefined
    })
    const firstPreview = await service.preview()
    const secondPreview = await service.preview()
    expect(firstPreview.confirmationToken).not.toBe(secondPreview.confirmationToken)
    const firstApply = service.apply({ confirmationToken: firstPreview.confirmationToken! })
    await firstEntered

    await expect(
      service.apply({ confirmationToken: secondPreview.confirmationToken! })
    ).rejects.toThrow('配置迁移正在进行，请稍候')
    releaseFirst()
    await expect(firstApply).resolves.toMatchObject({ ok: true })
  })

  it('returns a restart instruction when the runtime does not reflect the new counts', async () => {
    const fixture = await migrationFixture()
    const service = createChannelMigrationService({
      homeDir: fixture.homeDir,
      userDataDir: fixture.userDataDir,
      tokenBytes: () => Buffer.alloc(32, 12),
      settleAfterWrite: async () => undefined,
      verifyReload: async () => false
    })
    const preview = await service.preview()

    await expect(
      service.apply({ confirmationToken: preview.confirmationToken! })
    ).resolves.toMatchObject({
      ok: true,
      reloadReflected: false,
      message: '配置已导入；运行时尚未刷新，请重启 App。'
    })
  })

  it('verifies the exact merged counts including Desktop-only models', async () => {
    const fixture = await migrationFixture()
    fixture.target.customModels = {
      desktopOnlyModel: { channels: [{ provider: 'desktop' }] }
    }
    await writeFile(fixture.destinationPath, JSON.stringify(fixture.target), 'utf8')
    let verifiedCounts: {
      providerCount: number
      customModelCount: number
      routeCount: number
    } | null = null
    const service = createChannelMigrationService({
      homeDir: fixture.homeDir,
      userDataDir: fixture.userDataDir,
      tokenBytes: () => Buffer.alloc(32, 13),
      settleAfterWrite: async () => undefined,
      verifyReload: async (expected) => {
        verifiedCounts = expected
        return true
      }
    })
    const preview = await service.preview()

    await service.apply({ confirmationToken: preview.confirmationToken! })

    expect(verifiedCounts).toEqual({
      providerCount: 2,
      customModelCount: 2,
      routeCount: 1,
      configFingerprint: buildChannelMigrationFingerprint({
        ...fixture.target,
        providers: { desktop: {}, source: { apiKey: 'source-secret' } },
        customModels: {
          desktopOnlyModel: { channels: [{ provider: 'desktop' }] },
          modelA: { channels: [{ provider: 'source' }] }
        },
        daoRoutes: fixture.source.daoRoutes
      })
    })
  })

  it('does not count route comment entries that the runtime intentionally hides', async () => {
    const fixture = await migrationFixture()
    const sourceWithComment = {
      ...fixture.source,
      daoRoutes: {
        ...fixture.source.daoRoutes,
        routes: {
          _注: 'display-only note',
          modelA: { provider: 'source', model: 'upstream-a' }
        }
      }
    }
    await writeFile(fixture.sourcePath, JSON.stringify(sourceWithComment), 'utf8')
    let routeCount = -1
    const service = createChannelMigrationService({
      homeDir: fixture.homeDir,
      userDataDir: fixture.userDataDir,
      tokenBytes: () => Buffer.alloc(32, 14),
      settleAfterWrite: async () => undefined,
      verifyReload: async (expected) => {
        routeCount = expected.routeCount
        return true
      }
    })
    const preview = await service.preview()

    await service.apply({ confirmationToken: preview.confirmationToken! })

    expect(preview.routeCount).toBe(2)
    expect(routeCount).toBe(1)
  })

  it('rejects a same-count reload snapshot when the configuration fingerprint is stale', () => {
    const expected = {
      providerCount: 2,
      customModelCount: 2,
      routeCount: 1,
      configFingerprint: 'new-fingerprint'
    }

    expect(
      matchesChannelMigrationReload(expected, {
        ...expected,
        configFingerprint: 'old-fingerprint'
      })
    ).toBe(false)
    expect(matchesChannelMigrationReload(expected, expected)).toBe(true)
  })
})
