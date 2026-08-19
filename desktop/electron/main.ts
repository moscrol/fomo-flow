import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, protocol, shell } from 'electron'
import { writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { ELECTRON_IPC_CHANNELS, type ElectronIpcChannel } from './ipc/channels'
import { validateDesktopIpcPayload } from './ipc/capabilities'
import { createDaoDashboardService, createLoopbackJsonReader } from './services/dao-dashboard'
import {
  createDaoRuntimeFacade,
  resolveDaoRuntimeRoot,
  type DaoRuntimeFacade
} from './services/dao-runtime'
import {
  controlRequestUrl,
  isDaoObservationRequest,
  readDaoControlResponse,
  readDaoLocalApiKey,
  requiresDaoTaskAuthorization,
  type DaoControlRequestPayload
} from './services/dao-control'
import { createDaoObservationSource } from './services/dao-observation-source'
import { createDevinSessionSource } from './services/devin-session-source'
import {
  DAO_CONTROL_SCHEME,
  DAO_CONTROL_URL,
  isAllowedControlNavigation,
  renderDaoControlHtml,
  renderDaoControlUnavailableHtml,
  safeHandoffFilename,
  type DaoControlHtmlModule
} from './services/control-console'
import { isAllowedMainNavigation, isSafeExternalUrl } from './services/navigation'
import {
  createWorkAttentionLedger,
  type WorkAttentionLedger,
  type WorkResolution
} from './services/work-attention-ledger'
import {
  createTaskboardLocalAdapter,
  type PromoteWorkDraft,
  type TaskboardLocalAdapter
} from './services/taskboard-local'
import {
  createChannelMigrationService,
  matchesChannelMigrationReload,
  type ChannelMigrationService
} from './services/channel-migration'
import { createDevinAcpHost, type DevinAcpHost } from './services/devin-acp-host'
import { userStateFile } from './services/user-state'
import { resolveDevinAcpResources } from './services/devin-acp-resources'

let mainWindow: BrowserWindow | null = null
let controlWindow: BrowserWindow | null = null
let daoRuntime: DaoRuntimeFacade | null = null
let daoDashboard: ReturnType<typeof createDaoDashboardService> | null = null
let attentionLedger: WorkAttentionLedger | null = null
let taskboardAdapter: TaskboardLocalAdapter | null = null
let channelMigrationService: ChannelMigrationService | null = null
let daoObservationSource: ReturnType<typeof createDaoObservationSource> | null = null
let devinHostService: DevinAcpHost | null = null
let quittingAfterRuntimeStop = false

protocol.registerSchemesAsPrivileged([
  {
    scheme: DAO_CONTROL_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true
    }
  }
])

function preloadPath(): string {
  // Bun embeds __dirname at build time when bundling. Resolve from Electron's
  // app path instead so the same artifact works in dev and inside app.asar.
  return join(app.getAppPath(), 'electron-dist', 'preload.cjs')
}

function hostDirectory(): string {
  return join(app.getAppPath(), 'electron-dist')
}

function runtimeRoot(): string {
  return resolveDaoRuntimeRoot({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    hostDirectory: hostDirectory(),
    environment: process.env
  })
}

function runtime(): DaoRuntimeFacade {
  if (daoRuntime) return daoRuntime
  daoRuntime = createDaoRuntimeFacade({
    runtimeRoot: runtimeRoot(),
    userDataDir: app.getPath('userData')
  })
  return daoRuntime
}

function dashboard(): ReturnType<typeof createDaoDashboardService> {
  if (daoDashboard) return daoDashboard
  daoDashboard = createDaoDashboardService({
    getStatus: () => runtime().status(),
    readJson: createLoopbackJsonReader(() => runtime().status()),
    readObservationJson: (path) => observationSource().request(path)
  })
  return daoDashboard
}

function workLedger(): WorkAttentionLedger {
  if (attentionLedger) return attentionLedger
  attentionLedger = createWorkAttentionLedger({ userDataDir: app.getPath('userData') })
  return attentionLedger
}

function taskboard(): TaskboardLocalAdapter {
  if (taskboardAdapter) return taskboardAdapter
  taskboardAdapter = createTaskboardLocalAdapter({
    userDataDir: app.getPath('userData'),
    runtimeRoot: runtimeRoot()
  })
  return taskboardAdapter
}

function channelMigration(): ChannelMigrationService {
  if (channelMigrationService) return channelMigrationService
  channelMigrationService = createChannelMigrationService({
    userDataDir: app.getPath('userData'),
    verifyReload: async (expected) => {
      try {
        const [providerResponse, overviewResponse] = await Promise.all([
          requestDaoControl({ path: '/origin/ea/providers', method: 'GET' }),
          requestDaoControl({ path: '/origin/ea/overview', method: 'GET' })
        ])
        if (!providerResponse.ok || !overviewResponse.ok) return false
        const providerData = safeRecord(providerResponse.data)
        const overview = safeRecord(overviewResponse.data)
        const customModels = overview.custom_models
        const customModelCount = Array.isArray(customModels)
          ? customModels.length
          : Object.keys(safeRecord(customModels)).length
        return matchesChannelMigrationReload(expected, {
          providerCount: Object.keys(safeRecord(providerData.providers)).length,
          customModelCount,
          routeCount: Object.keys(safeRecord(overview.routes)).length,
          configFingerprint: String(overview.config_fingerprint || '')
        })
      } catch {
        return false
      }
    }
  })
  return channelMigrationService
}

function observationSource(): ReturnType<typeof createDaoObservationSource> {
  if (daoObservationSource) return daoObservationSource
  const devinSessions = createDevinSessionSource({
    statusDirectory: userStateFile('agent-status')
  })
  daoObservationSource = createDaoObservationSource({
    getDesktopUrl: () => runtime().status().url,
    descriptorPaths: [userStateFile('endpoint.json')],
    getLocalApiKey: (base) => readDaoLocalApiKey(base),
    getDevinSessions: async () => {
      const sessions = await devinSessions.sessions()
      const hosted = devinHostService?.observationSession()
      return hosted ? [...sessions, hosted] : sessions
    }
  })
  return daoObservationSource
}

async function chooseDevinDirectory(): Promise<string | null> {
  const owner = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined
  const options: Electron.OpenDialogOptions = {
    title: '选择 Devin 工作目录',
    buttonLabel: '选择此目录',
    properties: ['openDirectory', 'createDirectory']
  }
  const result = owner
    ? await dialog.showOpenDialog(owner, options)
    : await dialog.showOpenDialog(options)
  return result.canceled || result.filePaths.length !== 1 ? null : result.filePaths[0]
}

function devinHost(): DevinAcpHost {
  if (devinHostService) return devinHostService
  devinHostService = createDevinAcpHost({
    chooseDirectory: chooseDevinDirectory,
    resolveResources: () =>
      resolveDevinAcpResources({
        appPath: app.getAppPath(),
        isPackaged: app.isPackaged,
        resourcesPath: process.resourcesPath
      }),
    runtimeStatus: () => {
      const status = runtime().status()
      return { healthy: status.healthy, url: status.url }
    }
  })
  devinHostService.subscribe((snapshot) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(ELECTRON_IPC_CHANNELS.devinHostEvent, snapshot)
    }
  })
  return devinHostService
}

function safeRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

async function connectTaskboard() {
  const owner = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined
  const options: Electron.OpenDialogOptions = {
    title: '连接本地 Taskboard',
    buttonLabel: '连接',
    filters: [{ name: 'Taskboard launcher-runtime.json', extensions: ['json'] }],
    properties: ['openFile']
  }
  const result = owner
    ? await dialog.showOpenDialog(owner, options)
    : await dialog.showOpenDialog(options)
  if (result.canceled || result.filePaths.length !== 1) return taskboard().snapshot()
  return taskboard().selectDescriptor(result.filePaths[0])
}

function installNavigationGuards(
  window: BrowserWindow,
  isAllowedNavigation: (url: string) => boolean
): void {
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event, url) => {
    if (isAllowedNavigation(url)) return
    event.preventDefault()
    if (isSafeExternalUrl(url)) void shell.openExternal(url)
  })
}

async function loadRenderer(window: BrowserWindow): Promise<void> {
  const devServerUrl = process.env.ELECTRON_RENDERER_URL
  if (devServerUrl) {
    await window.loadURL(devServerUrl)
    return
  }
  await window.loadFile(join(app.getAppPath(), 'dist', 'index.html'))
}

async function createMainWindow(): Promise<BrowserWindow> {
  const window = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 1040,
    minHeight: 680,
    show: false,
    title: 'FOMO FLOW',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    backgroundColor: '#101417',
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  })
  mainWindow = window
  window.once('ready-to-show', () => window.show())
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null
  })
  installNavigationGuards(window, isAllowedMainNavigation)
  await loadRenderer(window)
  return window
}

function isTrustedWindowSender(event: Electron.IpcMainInvokeEvent): boolean {
  return [mainWindow, controlWindow].some(
    (window) => !!window && !window.isDestroyed() && event.sender.id === window.webContents.id
  )
}

function registerHandler(
  channel: ElectronIpcChannel,
  handler: (payload: unknown) => unknown | Promise<unknown>
): void {
  ipcMain.handle(channel, async (event, payload) => {
    if (!isTrustedWindowSender(event) || !validateDesktopIpcPayload(channel, payload)) {
      throw new Error('Dao Desktop request is not permitted')
    }
    return handler(payload)
  })
}

function registerMainWindowHandler(
  channel: ElectronIpcChannel,
  handler: (payload: unknown) => unknown | Promise<unknown>
): void {
  ipcMain.handle(channel, async (event, payload) => {
    if (
      !mainWindow ||
      mainWindow.isDestroyed() ||
      event.sender.id !== mainWindow.webContents.id ||
      !validateDesktopIpcPayload(channel, payload)
    ) {
      throw new Error('Dao Desktop request is not permitted')
    }
    return handler(payload)
  })
}

function loadDaoControlHtmlModule(): DaoControlHtmlModule {
  const modulePath = join(runtimeRoot(), 'ui', 'ea-config-html.js')
  // The Dao Web UI is an established CommonJS runtime resource. Keep it out of
  // the Electron bundle so packaged and development roots both resolve the same
  // source files.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require(modulePath) as DaoControlHtmlModule
}

function renderControlPage(): string {
  const port = runtime().status().port
  if (!port) return renderDaoControlUnavailableHtml()
  try {
    return renderDaoControlHtml(loadDaoControlHtmlModule(), port, (message) => {
      console.error(`[dao-control] ${message}`)
    })
  } catch (error) {
    console.error('[dao-control] failed to render control page', error)
    return renderDaoControlUnavailableHtml('控制台资源加载失败，请重试运行时或重新安装 FOMO FLOW。')
  }
}

function installControlProtocol(): void {
  protocol.handle(DAO_CONTROL_SCHEME, async (request) => {
    if (!isAllowedControlNavigation(request.url)) {
      return new Response('Not Found', { status: 404 })
    }
    const html = renderControlPage()
    return new Response(html, {
      headers: {
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        'Content-Type': 'text/html; charset=utf-8',
        Pragma: 'no-cache'
      }
    })
  })
}

async function saveControlHandoff(payload: unknown): Promise<{ ok: boolean; canceled?: boolean }> {
  const { content, filename } = payload as { content: string; filename?: string }
  const defaultPath = join(app.getPath('documents'), safeHandoffFilename(filename))
  const owner = controlWindow && !controlWindow.isDestroyed() ? controlWindow : mainWindow
  const result = owner
    ? await dialog.showSaveDialog(owner, {
        title: '保存 Dao 交接文档',
        defaultPath,
        filters: [{ name: 'Markdown', extensions: ['md'] }],
        properties: ['createDirectory', 'showOverwriteConfirmation']
      })
    : await dialog.showSaveDialog({
        title: '保存 Dao 交接文档',
        defaultPath,
        filters: [{ name: 'Markdown', extensions: ['md'] }],
        properties: ['createDirectory', 'showOverwriteConfirmation']
      })
  if (result.canceled || !result.filePath) return { ok: false, canceled: true }
  await writeFile(result.filePath, content, { encoding: 'utf8', mode: 0o600 })
  return { ok: true }
}

async function requestDaoControl(payload: unknown) {
  const request = payload as DaoControlRequestPayload
  if (isDaoObservationRequest(request)) {
    try {
      return { ok: true, status: 200, data: await observationSource().request(request.path) }
    } catch {
      // The Desktop-owned runtime remains the safe fallback during source transitions.
    }
  }
  const status = runtime().status()
  if (!status.url) {
    return { ok: false, status: 503, data: { error: '本地 Dao 运行时尚未就绪' } }
  }
  const url = controlRequestUrl(status.url, request.path)
  if (!url) {
    throw new Error('Dao control path is not permitted')
  }
  const serializedBody = request.body === undefined ? undefined : JSON.stringify(request.body)
  const headers: Record<string, string> = serializedBody
    ? { 'Content-Type': 'application/json' }
    : { accept: 'application/json' }
  if (requiresDaoTaskAuthorization(request.path)) {
    const localApiKey = await readDaoLocalApiKey(status.url)
    if (localApiKey) headers.Authorization = `Bearer ${localApiKey}`
  }
  const response = await fetch(url, {
    method: request.method,
    headers,
    body: serializedBody,
    signal: AbortSignal.timeout(30_000)
  })
  return readDaoControlResponse(response)
}

async function createControlWindow(): Promise<BrowserWindow> {
  if (controlWindow && !controlWindow.isDestroyed()) {
    if (controlWindow.isMinimized()) controlWindow.restore()
    controlWindow.show()
    controlWindow.focus()
    return controlWindow
  }

  await runtime()
    .start()
    .catch(() => runtime().status())
  const window = new BrowserWindow({
    width: 1540,
    height: 1000,
    minWidth: 1120,
    minHeight: 720,
    show: false,
    title: 'FOMO FLOW · 完整控制台',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    backgroundColor: '#101417',
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  })
  controlWindow = window
  window.once('ready-to-show', () => window.show())
  window.on('closed', () => {
    if (controlWindow === window) controlWindow = null
  })
  installNavigationGuards(window, isAllowedControlNavigation)
  await window.loadURL(DAO_CONTROL_URL)
  return window
}

function registerIpcHandlers(): void {
  registerHandler(ELECTRON_IPC_CHANNELS.runtimeStatus, () => runtime().status())
  registerHandler(ELECTRON_IPC_CHANNELS.runtimeRetry, () => runtime().start())
  registerHandler(ELECTRON_IPC_CHANNELS.dashboardSnapshot, () => dashboard().snapshot())
  registerHandler(ELECTRON_IPC_CHANNELS.shellOpenExternal, async (payload) => {
    await shell.openExternal((payload as { url: string }).url)
  })
  registerHandler(ELECTRON_IPC_CHANNELS.shellOpenConfig, async () => {
    await shell.openPath(join(app.getPath('userData'), 'config', '配置.json'))
  })
  registerHandler(ELECTRON_IPC_CHANNELS.clipboardWrite, (payload) => {
    clipboard.writeText((payload as { text: string }).text)
  })
  registerHandler(ELECTRON_IPC_CHANNELS.controlOpen, () => {
    void createControlWindow()
  })
  registerHandler(ELECTRON_IPC_CHANNELS.controlRequest, (payload) => requestDaoControl(payload))
  registerHandler(ELECTRON_IPC_CHANNELS.controlSaveHandoff, (payload) =>
    saveControlHandoff(payload)
  )
  registerHandler(ELECTRON_IPC_CHANNELS.workAttentionResolved, (payload) =>
    workLedger().resolved((payload as { fingerprints: string[] }).fingerprints)
  )
  registerHandler(ELECTRON_IPC_CHANNELS.workAttentionResolve, (payload) => {
    const request = payload as {
      fingerprint: string
      resolution: WorkResolution
      taskIdentifier?: string
    }
    return workLedger().resolve(request.fingerprint, request.resolution, request.taskIdentifier)
  })
  registerHandler(ELECTRON_IPC_CHANNELS.taskboardSnapshot, () => taskboard().snapshot())
  registerHandler(ELECTRON_IPC_CHANNELS.taskboardConnect, () => connectTaskboard())
  registerHandler(ELECTRON_IPC_CHANNELS.taskboardCreate, (payload) =>
    taskboard().create(payload as PromoteWorkDraft)
  )
  registerHandler(ELECTRON_IPC_CHANNELS.channelMigrationPreview, () => channelMigration().preview())
  registerHandler(ELECTRON_IPC_CHANNELS.channelMigrationApply, (payload) =>
    channelMigration().apply(payload as { confirmationToken: string })
  )
  registerMainWindowHandler(ELECTRON_IPC_CHANNELS.devinHostStatus, () => devinHost().status())
  registerMainWindowHandler(ELECTRON_IPC_CHANNELS.devinHostChooseWorkspace, () =>
    devinHost().chooseWorkspace()
  )
  registerMainWindowHandler(ELECTRON_IPC_CHANNELS.devinNativeOpen, (payload) =>
    devinHost().openNative(payload as { workspaceHandle: string })
  )
  registerMainWindowHandler(ELECTRON_IPC_CHANNELS.devinHostStart, (payload) =>
    devinHost().start(payload as { workspaceHandle: string })
  )
  registerMainWindowHandler(ELECTRON_IPC_CHANNELS.devinHostPrompt, (payload) =>
    devinHost().prompt(payload as { prompt: string; model?: string })
  )
  registerMainWindowHandler(ELECTRON_IPC_CHANNELS.devinHostPermission, (payload) =>
    devinHost().respondPermission(
      payload as { permissionId: string; decision: 'allow_once' | 'reject' }
    )
  )
  registerMainWindowHandler(ELECTRON_IPC_CHANNELS.devinHostCancel, () => devinHost().cancel())
  registerMainWindowHandler(ELECTRON_IPC_CHANNELS.devinHostStop, () => devinHost().stop())
}

function installApplicationMenu(): void {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: 'FOMO FLOW',
        submenu: [
          {
            label: '打开配置文件',
            click: () => void shell.openPath(join(app.getPath('userData'), 'config', '配置.json'))
          },
          {
            label: '打开完整控制台',
            accelerator: 'CmdOrCtrl+,',
            click: () => void createControlWindow()
          },
          { type: 'separator' },
          { role: 'quit' }
        ]
      },
      { role: 'editMenu' },
      { role: 'windowMenu' }
    ])
  )
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', (_event, commandLine) => {
    if (commandLine.includes('--dao-control-console')) void createControlWindow()
    if (controlWindow && !controlWindow.isDestroyed()) {
      if (controlWindow.isMinimized()) controlWindow.restore()
      controlWindow.focus()
      return
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.whenReady().then(async () => {
    app.setAppUserModelId('com.fomoflow.desktop')
    installControlProtocol()
    registerIpcHandlers()
    installApplicationMenu()
    await runtime()
      .start()
      .catch(() => runtime().status())
    await createMainWindow()
    if (process.argv.includes('--dao-control-console')) await createControlWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) void createMainWindow()
    })
  })
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', (event) => {
  if (quittingAfterRuntimeStop) return
  quittingAfterRuntimeStop = true
  event.preventDefault()
  void (async () => {
    if (devinHostService) await devinHostService.stop()
    if (daoRuntime) await daoRuntime.stop()
  })().finally(() => app.quit())
})
