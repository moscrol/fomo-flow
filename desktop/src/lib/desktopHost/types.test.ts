import { describe, expect, it } from 'vitest'

import { isDaoDesktopStatus } from './types'

describe('Dao desktop host status contract', () => {
  it('accepts only the redacted runtime status shape', () => {
    expect(
      isDaoDesktopStatus({
        healthy: true,
        running: true,
        port: 8955,
        url: 'http://127.0.0.1:8955',
        profile: 'desktop',
        imported: { config: false, revproxy: true },
        error: null
      })
    ).toBe(true)
    expect(isDaoDesktopStatus({ healthy: true, apiKey: 'secret' })).toBe(false)
  })
})
