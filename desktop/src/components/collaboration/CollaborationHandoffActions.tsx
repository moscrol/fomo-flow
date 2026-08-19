import { Clipboard, Download, LoaderCircle } from 'lucide-react'
import { useState } from 'react'

import { desktopHost } from '@/lib/desktopHost'

export function CollaborationHandoffActions({
  content,
  filename
}: {
  content: string
  filename: string
}) {
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const disabled = busy || !content.trim()

  async function copy(): Promise<void> {
    if (disabled) return
    setBusy(true)
    setNotice('')
    try {
      await desktopHost().writeClipboard(content)
      setNotice('交接包已复制')
    } catch {
      setNotice('交接包复制失败')
    } finally {
      setBusy(false)
    }
  }

  async function save(): Promise<void> {
    if (disabled) return
    setBusy(true)
    setNotice('')
    try {
      const result = await desktopHost().saveHandoff(content, filename)
      if (result.ok) setNotice('交接包已保存')
      else if (result.canceled) setNotice('已取消保存')
      else setNotice('交接包保存失败')
    } catch {
      setNotice('交接包保存失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="collaboration-handoff-actions" aria-label="交接包操作">
      <button
        className="collaboration-handoff-button control-action control-action-secondary"
        type="button"
        aria-label="复制交接包"
        disabled={disabled}
        onClick={() => void copy()}
      >
        {busy ? (
          <LoaderCircle size={14} className="spin" aria-hidden="true" />
        ) : (
          <Clipboard size={14} aria-hidden="true" />
        )}
        复制交接包
      </button>
      <button
        className="collaboration-handoff-button control-action control-action-secondary"
        type="button"
        aria-label="另存交接包"
        disabled={disabled}
        onClick={() => void save()}
      >
        {busy ? (
          <LoaderCircle size={14} className="spin" aria-hidden="true" />
        ) : (
          <Download size={14} aria-hidden="true" />
        )}
        另存交接包
      </button>
      {notice && (
        <span className="collaboration-handoff-notice" role="status">
          {notice}
        </span>
      )}
    </div>
  )
}
