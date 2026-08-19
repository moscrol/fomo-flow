import { CircleAlert, Eye, Inbox, ShieldAlert, Unplug } from 'lucide-react'
import { useMemo } from 'react'

import {
  buildCollaborationAttention,
  type CollaborationAttentionItem,
  type CollaborationAttentionKind
} from './collaborationAttention'
import type { CollaborationSession } from './collaborationModel'

const KIND_LABELS: Record<CollaborationAttentionKind, string> = {
  blocked: '验证阻塞',
  failed: '失败信号',
  stale: '失联观察',
  watch: '在途观察'
}

function KindIcon({ kind }: { kind: CollaborationAttentionKind }) {
  if (kind === 'blocked') return <ShieldAlert size={14} aria-hidden="true" />
  if (kind === 'failed') return <CircleAlert size={14} aria-hidden="true" />
  if (kind === 'stale') return <Unplug size={14} aria-hidden="true" />
  return <Eye size={14} aria-hidden="true" />
}

export function CollaborationAttentionQueue({
  sessions,
  now,
  selectedSessionId,
  onSelectSession
}: {
  sessions: CollaborationSession[]
  now: number
  selectedSessionId: string
  onSelectSession(sessionId: string): void
}) {
  const items = useMemo(() => buildCollaborationAttention(sessions, now), [sessions, now])

  return (
    <section className="collaboration-attention-queue" aria-label="人工接手队列">
      <div className="collaboration-attention-heading">
        <div>
          <span className="workspace-kicker">
            <Inbox size={12} aria-hidden="true" /> INBOX / HUMAN HANDOFF
          </span>
          <h3>人工接手队列</h3>
        </div>
        <strong>{items.length} 项</strong>
      </div>
      {items.length === 0 ? (
        <div className="collaboration-attention-empty">
          <Inbox size={19} aria-hidden="true" />
          <span>当前没有需要人工接手的会话。</span>
        </div>
      ) : (
        <div className="collaboration-attention-list" role="list" aria-label="待关注会话">
          {items.map((item) => (
            <AttentionItem
              item={item}
              key={item.sessionId}
              selected={item.sessionId === selectedSessionId}
              onSelect={() => onSelectSession(item.sessionId)}
            />
          ))}
        </div>
      )}
    </section>
  )
}

function AttentionItem({
  item,
  selected,
  onSelect
}: {
  item: CollaborationAttentionItem
  selected: boolean
  onSelect(): void
}) {
  return (
    <article className={`collaboration-attention-item tone-${item.tone}`} role="listitem">
      <span className="collaboration-attention-icon" aria-hidden="true">
        <KindIcon kind={item.kind} />
      </span>
      <button
        className={`collaboration-attention-button ${selected ? 'is-selected' : ''}`}
        type="button"
        aria-label={`查看会话：${item.title}`}
        aria-current={selected ? 'true' : undefined}
        onClick={onSelect}
      >
        <span className="collaboration-attention-topline">
          <strong>{item.title}</strong>
          <span className="collaboration-attention-kind">{KIND_LABELS[item.kind]}</span>
        </span>
        <small>{item.detail}</small>
        <span className="collaboration-attention-suggestion">{item.suggestion}</span>
      </button>
    </article>
  )
}
