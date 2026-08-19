import { useEffect, useRef } from 'react'

import type { PromoteWorkDraft } from '@/lib/desktopHost'

const FAILURE_LABEL: Record<PromoteWorkDraft['failureKind'], string> = {
  failed: '执行失败',
  timed_out: '执行超时',
  detached: '连接中断',
  transport_lost: '连接中断',
  stale: '状态过期',
  blocked: '验证阻塞'
}

export function PromoteWorkDialog({
  open,
  draft,
  writable,
  busy,
  status,
  onCancel,
  onConfirm
}: {
  open: boolean
  draft: PromoteWorkDraft
  writable: boolean
  busy: boolean
  status: string
  onCancel(): void
  onConfirm(): void
}) {
  const cancelRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    cancelRef.current?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onCancel()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, busy, onCancel])

  if (!open) return null
  return (
    <div className="promote-work-backdrop">
      <section
        className="promote-work-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="promote-work-title"
      >
        <header>
          <p className="workspace-kicker">EXPLICIT TASKBOARD WRITE</p>
          <h3 id="promote-work-title">加入任务板预览</h3>
          <p className="empty-note">确认前不会创建、更新或关闭任何 Taskboard 事项。</p>
        </header>
        <dl className="promote-work-preview">
          <div>
            <dt>标题</dt>
            <dd>{draft.title || 'FOMO FLOW 异常需要处理'}</dd>
          </div>
          <div>
            <dt>来源</dt>
            <dd>{draft.sourceKind === 'task' ? '任务' : '会话'}</dd>
          </div>
          <div>
            <dt>异常</dt>
            <dd>{FAILURE_LABEL[draft.failureKind]}</dd>
          </div>
          <div>
            <dt>验收</dt>
            <dd>{draft.acceptance}</dd>
          </div>
          <div>
            <dt>默认设置</dt>
            <dd>待办 · 中优先级</dd>
          </div>
        </dl>
        {!writable && <p className="control-status is-error">需要从当前 Codex 任务发起</p>}
        {status && <p className="control-status is-error">{status}</p>}
        <footer className="promote-work-actions">
          <button
            ref={cancelRef}
            type="button"
            className="control-action control-action-secondary"
            onClick={onCancel}
            disabled={busy}
          >
            取消
          </button>
          <button
            type="button"
            className="control-action control-action-primary"
            onClick={onConfirm}
            disabled={!writable || busy}
          >
            {busy ? '正在创建…' : '确认加入任务板'}
          </button>
        </footer>
      </section>
    </div>
  )
}
