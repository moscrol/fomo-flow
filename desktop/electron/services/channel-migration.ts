import { createHash, randomBytes } from 'node:crypto'
import { closeSync, fsyncSync, openSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { appendFile, chmod, copyFile, mkdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { userStateFile } from './user-state'

import type {
  ChannelMigrationApplyResult,
  ChannelMigrationPreview
} from '../../src/lib/desktopHost/channelMigration'

export type {
  ChannelMigrationApplyResult,
  ChannelMigrationPreview
} from '../../src/lib/desktopHost/channelMigration'

type JsonRecord = Record<string, unknown>

export type ChannelMigrationService = {
  preview(): Promise<ChannelMigrationPreview>
  apply(input: { confirmationToken: string }): Promise<ChannelMigrationApplyResult>
}

type PendingMigration = {
  expiresAt: number
  sourceHash: string
  targetHash: string
  merged: JsonRecord
  preview: Omit<ChannelMigrationPreview, 'confirmationToken'>
}

export type ChannelMigrationReloadExpectation = {
  providerCount: number
  customModelCount: number
  routeCount: number
  configFingerprint: string
}

export type ChannelMigrationReloadSnapshot = ChannelMigrationReloadExpectation

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : {}
}

function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function safeProviderName(value: string): string {
  const name = value.trim()
  if (
    /(?:authorization|bearer|basic|token|secret|password|api[_ -]?key)/iu.test(name) ||
    /^(?:sk-|akia|gh[pousr]_|xox[baprs]-)/iu.test(name)
  ) {
    return '未命名渠道'
  }
  return /^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,79}$/u.test(name) ? name : '未命名渠道'
}

function unavailablePreview(message: string): ChannelMigrationPreview {
  return {
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
    message
  }
}

export function buildSafeChannelMigrationPreview(
  source: JsonRecord,
  target: JsonRecord
): Omit<ChannelMigrationPreview, 'confirmationToken'> {
  const sourceProviders = asRecord(source.providers)
  const targetProviders = asRecord(target.providers)
  const sourceNames = Object.keys(sourceProviders)
  const targetNames = new Set(Object.keys(targetProviders))
  const providerNames = [...new Set(sourceNames.map(safeProviderName))]

  return {
    available: true,
    sourceLabel: '现有 FOMO FLOW 配置',
    providerNames,
    providerCount: sourceNames.length,
    customModelCount: Object.keys(asRecord(source.customModels)).length,
    routeCount: Object.keys(asRecord(asRecord(source.daoRoutes).routes)).length,
    newProviderCount: sourceNames.filter((name) => !targetNames.has(name)).length,
    overwrittenProviderCount: sourceNames.filter((name) => targetNames.has(name)).length,
    preservedDesktopProviderCount: [...targetNames].filter((name) => !(name in sourceProviders))
      .length,
    priorityPreserved: true,
    message: '找到可迁移的现有 FOMO FLOW 渠道与路由。'
  }
}

export function mergeDaoChannelConfig(source: JsonRecord, target: JsonRecord): JsonRecord {
  const sourceRoutes = asRecord(source.daoRoutes)
  const targetRoutes = asRecord(target.daoRoutes)
  const targetRouteMetadata = Object.fromEntries(
    Object.entries(targetRoutes).filter(([key]) => key.startsWith('_'))
  )

  return {
    ...target,
    providers: {
      ...asRecord(target.providers),
      ...asRecord(source.providers)
    },
    customModels: {
      ...asRecord(target.customModels),
      ...asRecord(source.customModels)
    },
    daoRoutes: {
      ...sourceRoutes,
      ...targetRouteMetadata
    }
  }
}

function contentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

export function buildChannelMigrationFingerprint(config: JsonRecord): string {
  return contentHash(JSON.stringify(config))
}

export function matchesChannelMigrationReload(
  expected: ChannelMigrationReloadExpectation,
  snapshot: ChannelMigrationReloadSnapshot
): boolean {
  return (
    snapshot.providerCount === expected.providerCount &&
    snapshot.customModelCount === expected.customModelCount &&
    snapshot.routeCount === expected.routeCount &&
    snapshot.configFingerprint === expected.configFingerprint
  )
}

function visibleRouteCount(routes: JsonRecord): number {
  return Object.entries(routes).filter(
    ([uid, route]) => !uid.startsWith('_') && isRecord(route) && Boolean(route.provider)
  ).length
}

function parseConfig(content: string, requireProviders: boolean): JsonRecord {
  const parsed = JSON.parse(content) as unknown
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('现有配置无法安全读取')
  }
  const config = parsed as JsonRecord
  if (
    !isRecord(config.providers) ||
    !isRecord(config.customModels) ||
    !isRecord(config.daoRoutes) ||
    !isRecord(config.daoRoutes.routes) ||
    (requireProviders && Object.keys(config.providers).length === 0)
  ) {
    throw new Error('现有配置无法安全读取')
  }
  return config
}

function migrationTimestamp(date: Date): string {
  return date.toISOString().replace(/[:.]/g, '-')
}

async function writePrivateAtomic(filePath: string, content: string): Promise<void> {
  const temporaryPath = join(
    dirname(filePath),
    `.${basename(filePath)}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`
  )
  let descriptor: number | null = null
  try {
    descriptor = openSync(temporaryPath, 'wx', 0o600)
    writeFileSync(descriptor, content, 'utf8')
    fsyncSync(descriptor)
    closeSync(descriptor)
    descriptor = null
    renameSync(temporaryPath, filePath)
  } catch (error) {
    if (descriptor !== null) {
      try {
        closeSync(descriptor)
      } catch {
        // Best-effort close before removing the private temporary file.
      }
    }
    try {
      unlinkSync(temporaryPath)
    } catch {
      // The temporary file may not have been created yet.
    }
    throw error
  }
}

export function createChannelMigrationService({
  userDataDir,
  homeDir = homedir(),
  now = () => new Date(),
  tokenBytes = () => randomBytes(32),
  tokenTtlMs = 60_000,
  settleAfterWrite = () => new Promise<void>((resolve) => setTimeout(resolve, 650)),
  copyDestination = (source, destination) => copyFile(source, destination),
  writeDestination = writePrivateAtomic,
  appendAudit = (auditPath, content) =>
    appendFile(auditPath, content, { encoding: 'utf8', mode: 0o600 }).then(() => undefined),
  verifyReload = async () => true
}: {
  userDataDir: string
  homeDir?: string
  now?: () => Date
  tokenBytes?: () => Buffer
  tokenTtlMs?: number
  settleAfterWrite?: () => Promise<void>
  copyDestination?: (source: string, destination: string) => Promise<void>
  writeDestination?: (destination: string, content: string) => Promise<void>
  appendAudit?: (auditPath: string, content: string) => Promise<void>
  verifyReload?: (expected: ChannelMigrationReloadExpectation) => Promise<boolean>
}): ChannelMigrationService {
  const sourcePath = userStateFile('配置.json', homeDir)
  const destinationPath = join(userDataDir, 'config', '配置.json')
  const pending = new Map<string, PendingMigration>()
  let migrationApplying = false

  return {
    async preview() {
      const currentTime = now().getTime()
      for (const [token, plan] of pending) {
        if (plan.expiresAt < currentTime) pending.delete(token)
      }
      while (pending.size >= 4) pending.delete(pending.keys().next().value as string)
      let sourceContent: string
      try {
        sourceContent = await readFile(sourcePath, 'utf8')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return unavailablePreview('没有找到现有 FOMO FLOW 配置。')
        }
        return unavailablePreview('现有配置无法安全读取。')
      }
      let targetContent: string
      try {
        targetContent = await readFile(destinationPath, 'utf8')
      } catch {
        return unavailablePreview('Desktop 配置暂时无法读取。')
      }
      let source: JsonRecord
      let target: JsonRecord
      try {
        source = parseConfig(sourceContent, true)
        target = parseConfig(targetContent, false)
      } catch {
        return unavailablePreview('现有配置无法安全读取。')
      }
      const preview = buildSafeChannelMigrationPreview(source, target)
      const confirmationToken = tokenBytes().toString('hex')
      pending.set(confirmationToken, {
        expiresAt: currentTime + tokenTtlMs,
        sourceHash: contentHash(sourceContent),
        targetHash: contentHash(targetContent),
        merged: mergeDaoChannelConfig(source, target),
        preview
      })
      return { ...preview, confirmationToken }
    },
    async apply({ confirmationToken }) {
      const planned = pending.get(confirmationToken)
      if (!planned || planned.expiresAt < now().getTime()) {
        pending.delete(confirmationToken)
        throw new Error('配置已变化，请重新检查')
      }
      if (migrationApplying) throw new Error('配置迁移正在进行，请稍候')
      migrationApplying = true
      try {
        let sourceContent: string
        let targetContent: string
        try {
          const contents = await Promise.all([
            readFile(sourcePath, 'utf8'),
            readFile(destinationPath, 'utf8')
          ])
          sourceContent = contents[0]
          targetContent = contents[1]
        } catch {
          pending.delete(confirmationToken)
          throw new Error('配置已变化，请重新检查')
        }
        if (
          contentHash(sourceContent) !== planned.sourceHash ||
          contentHash(targetContent) !== planned.targetHash
        ) {
          pending.delete(confirmationToken)
          throw new Error('配置已变化，请重新检查')
        }

        const backupDir = join(dirname(destinationPath), '.config-backups')
        try {
          await mkdir(backupDir, { recursive: true, mode: 0o700 })
          await chmod(backupDir, 0o700)
          const backupPath = join(
            backupDir,
            `${basename(destinationPath)}.${migrationTimestamp(now())}.bak`
          )
          await copyDestination(destinationPath, backupPath)
          await chmod(backupPath, 0o600)
        } catch {
          throw new Error('配置备份失败，请检查本机存储后重试')
        }

        let latestSourceContent: string
        let latestTargetContent: string
        try {
          const latestContents = await Promise.all([
            readFile(sourcePath, 'utf8'),
            readFile(destinationPath, 'utf8')
          ])
          latestSourceContent = latestContents[0]
          latestTargetContent = latestContents[1]
        } catch {
          pending.delete(confirmationToken)
          throw new Error('配置已变化，请重新检查')
        }
        if (
          contentHash(latestSourceContent) !== planned.sourceHash ||
          contentHash(latestTargetContent) !== planned.targetHash
        ) {
          pending.delete(confirmationToken)
          throw new Error('配置已变化，请重新检查')
        }
        try {
          await writeDestination(destinationPath, `${JSON.stringify(planned.merged, null, 2)}\n`)
        } catch {
          throw new Error('配置写入失败，旧配置已保留')
        }
        pending.delete(confirmationToken)

        const runtimeDir = join(userDataDir, 'runtime')
        const auditPath = join(runtimeDir, 'channel-migration-audit.jsonl')
        let auditRecorded = true
        try {
          await mkdir(runtimeDir, { recursive: true, mode: 0o700 })
          await chmod(runtimeDir, 0o700)
          await appendAudit(
            auditPath,
            `${JSON.stringify({
              version: 1,
              migratedAt: now().toISOString(),
              providerCount: planned.preview.providerCount,
              customModelCount: planned.preview.customModelCount,
              routeCount: planned.preview.routeCount,
              result: 'success',
              sourceHash: planned.sourceHash.slice(0, 16)
            })}\n`
          )
          await chmod(auditPath, 0o600)
        } catch {
          auditRecorded = false
        }
        await settleAfterWrite().catch(() => undefined)
        const mergedRoutes = asRecord(asRecord(planned.merged.daoRoutes).routes)
        const reloadReflected = await verifyReload({
          providerCount: Object.keys(asRecord(planned.merged.providers)).length,
          customModelCount: Object.keys(asRecord(planned.merged.customModels)).length,
          routeCount: visibleRouteCount(mergedRoutes),
          configFingerprint: buildChannelMigrationFingerprint(planned.merged)
        }).catch(() => false)

        return {
          ok: true,
          providerCount: planned.preview.providerCount,
          customModelCount: planned.preview.customModelCount,
          routeCount: planned.preview.routeCount,
          backupCreated: true,
          priorityPreserved: true,
          reloadReflected,
          message: !reloadReflected
            ? '配置已导入；运行时尚未刷新，请重启 App。'
            : auditRecorded
              ? '现有 FOMO FLOW 渠道与路由已安全导入。'
              : '现有 FOMO FLOW 渠道与路由已导入，但审计记录暂不可用。'
        }
      } finally {
        migrationApplying = false
      }
    }
  }
}
