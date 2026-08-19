import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'

import { DEVIN_MAC_CLI_PATH, launchNativeDevin } from './devin-native-launch'

describe('native Devin launcher', () => {
  it('opens the fixed Devin CLI in a new agents window for the selected workspace', async () => {
    const child = Object.assign(new EventEmitter(), { unref: vi.fn() })
    const spawnProcess = vi.fn(() => child as never)

    const launched = launchNativeDevin('/Users/private/project', {
      exists: (path) => path === DEVIN_MAC_CLI_PATH,
      spawnProcess
    })
    child.emit('spawn')
    await launched

    expect(spawnProcess).toHaveBeenCalledWith(
      DEVIN_MAC_CLI_PATH,
      ['--new-window', '--agents', '/Users/private/project'],
      { detached: true, stdio: 'ignore' }
    )
    expect(child.unref).toHaveBeenCalledTimes(1)
  })

  it('fails with stable text when the fixed Devin CLI is unavailable', async () => {
    await expect(
      launchNativeDevin('/Users/private/project', { exists: () => false })
    ).rejects.toThrow('未找到 Devin 原生应用')
  })
})
