import { join, resolve } from 'node:path'

import type { DaoDesktopStatus } from '../../src/lib/desktopHost/types'

export type DaoRuntimeFacade = {
  start(): Promise<DaoDesktopStatus>
  status(): DaoDesktopStatus
  stop(): Promise<void>
}

type DaoRuntimeModule = {
  DaoDesktopRuntime: new (options: { userDataDir: string; runtimeRoot: string }) => DaoRuntimeFacade
}

export function resolveDaoRuntimeRoot({
  isPackaged,
  resourcesPath,
  hostDirectory,
  environment
}: {
  isPackaged: boolean
  resourcesPath: string
  hostDirectory: string
  environment: Record<string, string | undefined>
}): string {
  if (isPackaged) return join(resourcesPath, 'dao-runtime')
  if (environment.DAO_DESKTOP_RUNTIME_ROOT) return resolve(environment.DAO_DESKTOP_RUNTIME_ROOT)
  return resolve(hostDirectory, '../..')
}

export function createDaoRuntimeFacade({
  runtimeRoot,
  userDataDir,
  // Dao's established runtime is CommonJS and must be loaded by absolute path
  // after Electron has resolved the packaged resource directory.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  loadModule = (modulePath) => require(modulePath) as DaoRuntimeModule
}: {
  runtimeRoot: string
  userDataDir: string
  loadModule?: (modulePath: string) => DaoRuntimeModule
}): DaoRuntimeFacade {
  const modulePath = join(runtimeRoot, 'core', 'dao_desktop_runtime.js')
  const loaded = loadModule(modulePath)
  return new loaded.DaoDesktopRuntime({ userDataDir, runtimeRoot })
}
