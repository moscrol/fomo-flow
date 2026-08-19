import { describe, expect, it } from 'vitest'

import { isAllowedControlNavigation } from './control-console'
import { isAllowedMainNavigation } from './navigation'

describe('Dao Desktop navigation policy', () => {
  it('accepts only local renderer or runtime pages', () => {
    expect(isAllowedMainNavigation('http://127.0.0.1:8955/hud')).toBe(true)
    expect(isAllowedMainNavigation('http://localhost:1420/')).toBe(true)
    expect(isAllowedMainNavigation('http://[::1]:8955/hud')).toBe(true)
    expect(isAllowedMainNavigation('https://example.com')).toBe(false)
    expect(isAllowedMainNavigation('file:///etc/passwd')).toBe(false)
  })

  it('keeps the full control console on its private app origin', () => {
    expect(isAllowedControlNavigation('fomo-flow://control/')).toBe(true)
    expect(isAllowedControlNavigation('fomo-flow://control/settings')).toBe(false)
    expect(isAllowedControlNavigation('fomo-flow://control/?redirect=https://evil.test')).toBe(false)
    expect(isAllowedControlNavigation('https://example.com')).toBe(false)
  })
})
