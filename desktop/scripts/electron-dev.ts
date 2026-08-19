/*
 * Adapted from cc-haha's desktop/scripts/electron-dev.ts under the MIT License.
 * Copyright (c) 2026 cc-haha. See ../THIRD_PARTY_NOTICES.md.
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const RENDERER_URL = 'http://127.0.0.1:1420'
const LOOPBACK_NO_PROXY = ['localhost', '127.0.0.1', '::1']

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function mergeNoProxy(existing: string | undefined): string {
  const values = new Set(
    (existing ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean)
  )
  LOOPBACK_NO_PROXY.forEach((value) => values.add(value))
  return Array.from(values).join(',')
}

function electronExecutable(desktopRoot: string): string {
  const candidates =
    process.platform === 'darwin'
      ? [
          path.join(
            desktopRoot,
            'node_modules',
            'electron',
            'dist',
            'Electron.app',
            'Contents',
            'MacOS',
            'Electron'
          )
        ]
      : process.platform === 'win32'
        ? [path.join(desktopRoot, 'node_modules', 'electron', 'dist', 'electron.exe')]
        : [path.join(desktopRoot, 'node_modules', 'electron', 'dist', 'electron')]
  const resolved = candidates.find(existsSync)
  if (!resolved)
    throw new Error('Electron executable is unavailable; run bun install in desktop first.')
  return resolved
}

async function waitForRenderer(): Promise<void> {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    try {
      if ((await fetch(RENDERER_URL)).ok) return
    } catch {
      await delay(250)
    }
  }
  throw new Error(`Timed out waiting for Vite at ${RENDERER_URL}`)
}

async function main(): Promise<void> {
  const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const noProxy = mergeNoProxy(process.env.NO_PROXY ?? process.env.no_proxy)
  const environment = {
    ...process.env,
    ELECTRON_RENDERER_URL: RENDERER_URL,
    NO_PROXY: noProxy,
    no_proxy: noProxy
  }
  const vite = await createServer({
    root: desktopRoot,
    configFile: path.join(desktopRoot, 'vite.config.ts')
  })
  await vite.listen()
  vite.printUrls()
  try {
    await waitForRenderer()
    const electron = spawn(electronExecutable(desktopRoot), ['./electron-dist/main.cjs'], {
      cwd: desktopRoot,
      env: environment,
      stdio: 'inherit'
    })
    const code = await new Promise<number>((resolve, reject) => {
      electron.once('error', reject)
      electron.once('exit', (value) => resolve(value ?? 0))
    })
    process.exitCode = code
  } finally {
    await vite.close()
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main()
}
