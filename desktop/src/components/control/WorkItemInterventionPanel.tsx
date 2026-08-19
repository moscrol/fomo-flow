import { useEffect, useState } from 'react'

import { CollaborationHandoffActions } from '@/components/collaboration/CollaborationHandoffActions'
import type {
  InterventionCandidate,
  InterventionSummary
} from '@/components/work/workItemInterventionModel'
import { ROUTING_PROFILES } from '@/lib/routingDecision'
import { ActionButton, ControlListEmpty, ControlPanel, ControlStatus } from './ControlPrimitives'

type WorkItemInterventionPanelProps = {
  title: string
  summary: InterventionSummary | null
  handoff: string
  loading: boolean
  status: string
  onRefresh(): void
}

type DraftCandidateRow = {
  id: string
  candidate: InterventionCandidate
}

function createDraftRows(candidates: InterventionCandidate[]): DraftCandidateRow[] {
  return candidates.map((candidate, sourceIndex) => ({
    id: `candidate-${sourceIndex}`,
    candidate
  }))
}

function candidateLabel(candidate: InterventionCandidate): string {
  if (candidate.provider && candidate.model) return `${candidate.provider} · ${candidate.model}`
  return candidate.provider || candidate.model || '未命名渠道'
}

export function WorkItemInterventionPanel({
  title,
  summary,
  handoff,
  loading,
  status,
  onRefresh
}: WorkItemInterventionPanelProps) {
  const [draft, setDraft] = useState<DraftCandidateRow[]>(() =>
    createDraftRows(summary?.candidates ?? [])
  )
  const [draftChanged, setDraftChanged] = useState(false)

  useEffect(() => {
    setDraft(createDraftRows(summary?.candidates ?? []))
    setDraftChanged(false)
  }, [summary])

  function move(index: number, offset: -1 | 1): void {
    const nextIndex = index + offset
    if (nextIndex < 0 || nextIndex >= draft.length) return
    setDraft((current) => {
      const next = [...current]
      ;[next[index], next[nextIndex]] = [next[nextIndex], next[index]]
      return next
    })
    setDraftChanged(true)
  }

  function resetDraft(): void {
    setDraft(createDraftRows(summary?.candidates ?? []))
    setDraftChanged(false)
  }

  const profileLabel =
    ROUTING_PROFILES.find((profile) => profile.id === summary?.profile)?.label || '均衡'
  const profileSourceLabel = summary?.profileSource === 'advisory' ? '接口返回' : '安全默认'

  return (
    <ControlPanel title="可选干预" note="只读建议，不会自动切换">
      <div className="work-intervention-panel">
        <p className="empty-note">当前工作：{title}。你可以比较路由建议，或生成交接包。</p>
        <p className="work-intervention-profile">
          建议视角：{profileLabel}（{profileSourceLabel}）
        </p>
        {draft.length ? (
          <div className="work-intervention-candidates" role="list" aria-label="路由建议">
            {draft.map((row, index) => {
              const { candidate } = row
              const label = candidateLabel(candidate)
              return (
                <div className="work-intervention-candidate" key={row.id} role="listitem">
                  <div>
                    <strong>{label}</strong>
                    <span>
                      {candidate.score === null ? '暂无评分' : `评分 ${candidate.score}`}
                      {candidate.reason ? ` · ${candidate.reason}` : ''}
                    </span>
                  </div>
                  <div className="work-intervention-draft-actions">
                    <button
                      type="button"
                      className="control-action control-action-quiet"
                      aria-label={`将${label}上移`}
                      disabled={index === 0}
                      onClick={() => move(index, -1)}
                    >
                      上移
                    </button>
                    <button
                      type="button"
                      className="control-action control-action-quiet"
                      aria-label={`将${label}下移`}
                      disabled={index === draft.length - 1}
                      onClick={() => move(index, 1)}
                    >
                      下移
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        ) : (
          <ControlListEmpty label="暂无可比较的路由建议。" />
        )}
        <p className="work-intervention-advisory">
          {summary?.message ?? '仅供比较，不会自动切换。'}
        </p>
        {draftChanged && <p className="empty-note">草稿顺序不会自动保存。</p>}
        <div className="work-intervention-actions">
          <ActionButton onClick={onRefresh} busy={loading}>
            重新读取建议
          </ActionButton>
          <button
            type="button"
            className="control-action control-action-secondary"
            disabled={!draftChanged}
            onClick={resetDraft}
          >
            重置顺序草稿
          </button>
          <CollaborationHandoffActions content={handoff} filename="dao-flow-work-handoff.md" />
        </div>
        <ControlStatus message={status} error={Boolean(status)} />
      </div>
    </ControlPanel>
  )
}
