import { describe, expect, it } from 'vitest'

import {
  DAO_CONTROL_URL,
  isAllowedControlNavigation,
  renderDaoControlHtml,
  renderDaoControlUnavailableHtml,
  safeHandoffFilename
} from './control-console'

describe('FOMO FLOW desktop control console', () => {
  it('only permits the private control origin', () => {
    expect(isAllowedControlNavigation(DAO_CONTROL_URL)).toBe(true)
    expect(isAllowedControlNavigation('fomo-flow://control')).toBe(true)
    expect(isAllowedControlNavigation('fomo-flow://control/?next=evil')).toBe(false)
    expect(isAllowedControlNavigation('fomo-flow://other/')).toBe(false)
    expect(isAllowedControlNavigation('http://127.0.0.1:8955/hud')).toBe(false)
  })

  it('normalizes handoff filenames and reuses the checked Dao Web HTML', () => {
    expect(safeHandoffFilename('fomo-flow-revproxy-handoff.md')).toBe('fomo-flow-revproxy-handoff.md')
    expect(safeHandoffFilename('../secrets.txt')).toBe('fomo-flow-handoff.md')
    expect(safeHandoffFilename(undefined)).toBe('fomo-flow-handoff.md')

    const html = renderDaoControlHtml(
      {
        getCheckedEaConfigHtml: (port, _nonce, options) =>
          `<body data-port="${port}">${String(options?.desktop)}:${String(options?.foldBridge)}</body>`,
        getEaConfigHtml: () => 'fallback'
      },
      8955
    )
    expect(html).toContain('8955')
    expect(html).toContain('true:true')
  })

  it('escapes runtime errors in the unavailable page', () => {
    const html = renderDaoControlUnavailableHtml('<script>alert(1)</script>')
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
  })
})
