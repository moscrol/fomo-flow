import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'

export const DEVIN_MAC_CLI_PATH = '/Applications/Devin.app/Contents/Resources/app/bin/devin-desktop'

type LaunchInput = {
  exists?: (path: string) => boolean
  spawnProcess?: typeof spawn
}

export async function launchNativeDevin(
  workspacePath: string,
  input: LaunchInput = {}
): Promise<void> {
  const exists = input.exists ?? existsSync
  if (!exists(DEVIN_MAC_CLI_PATH)) throw new Error('未找到 Devin 原生应用，请安装或更新 Devin。')

  const child = (input.spawnProcess ?? spawn)(
    DEVIN_MAC_CLI_PATH,
    ['--new-window', '--agents', workspacePath],
    { detached: true, stdio: 'ignore' }
  ) as ChildProcess
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve)
    child.once('error', () => reject(new Error('Devin 原生窗口打开失败，请重试。')))
  })
  child.unref()
}
