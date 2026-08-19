export const DAO_CONTROL_SCHEME = 'fomo-flow'
export const DAO_CONTROL_HOST = 'control'
export const DAO_CONTROL_URL = `${DAO_CONTROL_SCHEME}://${DAO_CONTROL_HOST}/`

const HANDOFF_FILENAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*\.md$/i

export type DaoControlHtmlModule = {
  getCheckedEaConfigHtml?: (
    port: number,
    nonce?: string,
    opts?: { desktop?: boolean; foldBridge?: boolean },
    onError?: (message: string) => void
  ) => string
  getEaConfigHtml: (
    port: number,
    nonce?: string,
    opts?: { desktop?: boolean; foldBridge?: boolean }
  ) => string
}

export function isAllowedControlNavigation(value: string): boolean {
  try {
    const parsed = new URL(value)
    return (
      parsed.protocol === `${DAO_CONTROL_SCHEME}:` &&
      parsed.hostname === DAO_CONTROL_HOST &&
      (parsed.pathname === '/' || parsed.pathname === '') &&
      !parsed.username &&
      !parsed.password &&
      !parsed.search &&
      !parsed.hash
    )
  } catch {
    return false
  }
}

export function safeHandoffFilename(value: unknown): string {
  if (typeof value !== 'string') return 'fomo-flow-handoff.md'
  const candidate = value.trim()
  return HANDOFF_FILENAME_RE.test(candidate) ? candidate : 'fomo-flow-handoff.md'
}

export function renderDaoControlHtml(
  module: DaoControlHtmlModule,
  port: number,
  onError?: (message: string) => void
): string {
  const options = { desktop: true, foldBridge: true }
  if (typeof module.getCheckedEaConfigHtml === 'function') {
    return module.getCheckedEaConfigHtml(port, undefined, options, onError)
  }
  return module.getEaConfigHtml(port, undefined, options)
}

export function renderDaoControlUnavailableHtml(message = '本地 Dao 运行时尚未就绪。'): string {
  const escaped = message.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    }
    return entities[character] ?? character
  })
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>FOMO FLOW 控制台</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#101417;color:#e8ecef;font:14px -apple-system,BlinkMacSystemFont,"SF Pro Text",sans-serif}main{max-width:560px;padding:32px;border:1px solid #354049;border-radius:16px;background:#171d21;box-shadow:0 20px 60px #0005}h1{margin:0 0 12px;font-size:20px}p{opacity:.72;line-height:1.6}</style><main><h1>控制台暂不可用</h1><p>${escaped}</p><p>请回到主窗口点击“重试运行时”，然后重新打开控制台。</p></main></html>`
}
