export const ELECTRON_IPC_CHANNELS = {
  runtimeStatus: 'dao:runtime-status',
  runtimeRetry: 'dao:runtime-retry',
  dashboardSnapshot: 'dao:dashboard-snapshot',
  shellOpenExternal: 'dao:open-external',
  shellOpenConfig: 'dao:open-config',
  clipboardWrite: 'dao:clipboard-write',
  controlOpen: 'dao:control-open',
  controlRequest: 'dao:control-request',
  controlSaveHandoff: 'dao:control-save-handoff',
  workAttentionResolved: 'dao:work-attention-resolved',
  workAttentionResolve: 'dao:work-attention-resolve',
  taskboardSnapshot: 'dao:taskboard-snapshot',
  taskboardConnect: 'dao:taskboard-connect',
  taskboardCreate: 'dao:taskboard-create',
  channelMigrationPreview: 'dao:channel-migration-preview',
  channelMigrationApply: 'dao:channel-migration-apply',
  devinHostStatus: 'dao:devin-host-status',
  devinHostChooseWorkspace: 'dao:devin-host-choose-workspace',
  devinNativeOpen: 'dao:devin-native-open',
  devinHostStart: 'dao:devin-host-start',
  devinHostPrompt: 'dao:devin-host-prompt',
  devinHostPermission: 'dao:devin-host-permission',
  devinHostCancel: 'dao:devin-host-cancel',
  devinHostStop: 'dao:devin-host-stop',
  devinHostEvent: 'dao:devin-host-event'
} as const

export type ElectronIpcChannel = (typeof ELECTRON_IPC_CHANNELS)[keyof typeof ELECTRON_IPC_CHANNELS]
