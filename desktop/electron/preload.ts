import { contextBridge, ipcRenderer } from 'electron'

import { ELECTRON_IPC_CHANNELS } from './ipc/channels'

const desktopHost = {
  getRuntimeStatus: () => ipcRenderer.invoke(ELECTRON_IPC_CHANNELS.runtimeStatus),
  retryRuntime: () => ipcRenderer.invoke(ELECTRON_IPC_CHANNELS.runtimeRetry),
  getDashboardSnapshot: () => ipcRenderer.invoke(ELECTRON_IPC_CHANNELS.dashboardSnapshot),
  openExternal: (url: string) =>
    ipcRenderer.invoke(ELECTRON_IPC_CHANNELS.shellOpenExternal, { url }),
  openConfig: () => ipcRenderer.invoke(ELECTRON_IPC_CHANNELS.shellOpenConfig),
  openControlConsole: () => ipcRenderer.invoke(ELECTRON_IPC_CHANNELS.controlOpen),
  requestControl: (path: string, method: 'GET' | 'POST' | 'DELETE' = 'GET', body?: unknown) =>
    ipcRenderer.invoke(ELECTRON_IPC_CHANNELS.controlRequest, { path, method, body }),
  saveHandoff: (content: string, filename?: string) =>
    ipcRenderer.invoke(ELECTRON_IPC_CHANNELS.controlSaveHandoff, { content, filename }),
  writeClipboard: (text: string) =>
    ipcRenderer.invoke(ELECTRON_IPC_CHANNELS.clipboardWrite, { text }),
  getResolvedWork: (fingerprints: string[]) =>
    ipcRenderer.invoke(ELECTRON_IPC_CHANNELS.workAttentionResolved, { fingerprints }),
  resolveWork: (
    fingerprint: string,
    resolution: 'acknowledged' | 'promoted',
    taskIdentifier?: string
  ) =>
    ipcRenderer.invoke(ELECTRON_IPC_CHANNELS.workAttentionResolve, {
      fingerprint,
      resolution,
      ...(taskIdentifier ? { taskIdentifier } : {})
    }),
  getTaskboardSnapshot: () => ipcRenderer.invoke(ELECTRON_IPC_CHANNELS.taskboardSnapshot),
  connectTaskboard: () => ipcRenderer.invoke(ELECTRON_IPC_CHANNELS.taskboardConnect),
  createTaskboardWork: (draft: {
    fingerprint: string
    title: string
    sourceKind: 'session' | 'task'
    failureKind: 'failed' | 'timed_out' | 'detached' | 'transport_lost' | 'stale' | 'blocked'
    acceptance: string
  }) => ipcRenderer.invoke(ELECTRON_IPC_CHANNELS.taskboardCreate, draft),
  previewChannelMigration: () => ipcRenderer.invoke(ELECTRON_IPC_CHANNELS.channelMigrationPreview),
  applyChannelMigration: (confirmationToken: string) =>
    ipcRenderer.invoke(ELECTRON_IPC_CHANNELS.channelMigrationApply, { confirmationToken }),
  getDevinHostStatus: () => ipcRenderer.invoke(ELECTRON_IPC_CHANNELS.devinHostStatus),
  chooseDevinWorkspace: () => ipcRenderer.invoke(ELECTRON_IPC_CHANNELS.devinHostChooseWorkspace),
  openDevinNative: (workspaceHandle: string) =>
    ipcRenderer.invoke(ELECTRON_IPC_CHANNELS.devinNativeOpen, { workspaceHandle }),
  startDevinHost: (workspaceHandle: string) =>
    ipcRenderer.invoke(ELECTRON_IPC_CHANNELS.devinHostStart, { workspaceHandle }),
  promptDevinHost: (prompt: string, model?: string) =>
    ipcRenderer.invoke(ELECTRON_IPC_CHANNELS.devinHostPrompt, {
      prompt,
      ...(model ? { model } : {})
    }),
  respondDevinPermission: (permissionId: string, decision: 'allow_once' | 'reject') =>
    ipcRenderer.invoke(ELECTRON_IPC_CHANNELS.devinHostPermission, {
      permissionId,
      decision
    }),
  cancelDevinHost: () => ipcRenderer.invoke(ELECTRON_IPC_CHANNELS.devinHostCancel),
  stopDevinHost: () => ipcRenderer.invoke(ELECTRON_IPC_CHANNELS.devinHostStop),
  subscribeDevinHost: (listener: (snapshot: unknown) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, snapshot: unknown) => listener(snapshot)
    ipcRenderer.on(ELECTRON_IPC_CHANNELS.devinHostEvent, handler)
    return () => ipcRenderer.removeListener(ELECTRON_IPC_CHANNELS.devinHostEvent, handler)
  }
}

const daoControlHost = {
  openExternal: (url: string) =>
    ipcRenderer.invoke(ELECTRON_IPC_CHANNELS.shellOpenExternal, { url }),
  openConfig: () => ipcRenderer.invoke(ELECTRON_IPC_CHANNELS.shellOpenConfig),
  request: (path: string, method: 'GET' | 'POST' | 'DELETE' = 'GET', body?: unknown) =>
    ipcRenderer.invoke(ELECTRON_IPC_CHANNELS.controlRequest, { path, method, body }),
  copyText: (text: string) => ipcRenderer.invoke(ELECTRON_IPC_CHANNELS.clipboardWrite, { text }),
  saveHandoff: (content: string, filename?: string) =>
    ipcRenderer.invoke(ELECTRON_IPC_CHANNELS.controlSaveHandoff, { content, filename })
}

contextBridge.exposeInMainWorld('desktopHost', desktopHost)
contextBridge.exposeInMainWorld('daoControlHost', daoControlHost)
