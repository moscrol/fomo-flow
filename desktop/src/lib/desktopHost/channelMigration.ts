export type ChannelMigrationCounts = {
  providerCount: number
  customModelCount: number
  routeCount: number
}

export type ChannelMigrationPreview = ChannelMigrationCounts & {
  available: boolean
  sourceLabel: '现有 FOMO FLOW 配置'
  providerNames: string[]
  newProviderCount: number
  overwrittenProviderCount: number
  preservedDesktopProviderCount: number
  priorityPreserved: true
  confirmationToken?: string
  message: string
}

export type ChannelMigrationApplyResult = ChannelMigrationCounts & {
  ok: true
  backupCreated: true
  priorityPreserved: true
  reloadReflected: boolean
  message: string
}
