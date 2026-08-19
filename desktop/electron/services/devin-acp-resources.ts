import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

export const DEVIN_MAC_ACP_PATH =
  '/Applications/Devin.app/Contents/Resources/app/extensions/windsurf/devin/bin/devin'

type ResourceInput = {
  appPath: string
  isPackaged: boolean
  resourcesPath: string
  exists?: (path: string) => boolean
}

export type DevinAcpResources =
  | { available: true; devinPath: string; proxyPath: string }
  | { available: false; reason: 'devin_missing' | 'proxy_missing' }

export function resolveDevinAcpResources(input: ResourceInput): DevinAcpResources {
  const exists = input.exists ?? existsSync
  const proxyPath = input.isPackaged
    ? join(input.resourcesPath, 'dao-acp-host', 'dao-acp-stdio-proxy.js')
    : resolve(input.appPath, '..', 'dao-acp-stdio-proxy.js')

  if (!exists(DEVIN_MAC_ACP_PATH)) return { available: false, reason: 'devin_missing' }
  if (!exists(proxyPath)) return { available: false, reason: 'proxy_missing' }
  return { available: true, devinPath: DEVIN_MAC_ACP_PATH, proxyPath }
}
