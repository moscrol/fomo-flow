import type { CollaborationTask } from '@/components/collaboration/collaborationModel'
import { sanitizeDisplayText } from './displaySanitizer'

export type ArtifactReviewOutcome = 'completed' | 'failed' | 'empty' | 'running'
export type ArtifactReviewArtifact = { ref: string; kind: string }
export type TaskArtifactReview = {
  outcome: ArtifactReviewOutcome
  message: string
  errorCategory: string
  exitCode: number | null
  stdoutSummary: string
  stderrSummary: string
  artifacts: ArtifactReviewArtifact[]
  artifactCount: number
}

const MAX_TEXT = 220

function safeText(value: unknown, fallback = '', limit = MAX_TEXT): string {
  return sanitizeDisplayText(value, fallback, limit)
}

function outcome(task: CollaborationTask): ArtifactReviewOutcome {
  const status = task.status.toLowerCase()
  if (['running', 'queued'].includes(status)) return 'running'
  if (['failed', 'timed_out', 'cancelled', 'detached', 'transport_lost'].includes(status))
    return 'failed'
  if (task.result.artifacts.length === 0) return 'empty'
  return 'completed'
}

export function projectTaskArtifactReview(task: CollaborationTask): TaskArtifactReview {
  const result = task.result
  const currentOutcome = outcome(task)
  const messages: Record<ArtifactReviewOutcome, string> = {
    completed: '任务已完成，可以审阅产物。',
    failed: '任务失败，请先查看错误摘要。',
    empty: '任务已结束，但没有可审阅的产物。',
    running: '任务仍在进行中，完成后会显示产物。'
  }
  const artifacts = result.artifacts.slice(0, 20).map((artifact) => ({
    ref: safeText(artifact.ref, '未命名产物', 120),
    kind: safeText(artifact.kind, '未知类型', 40)
  }))
  return {
    outcome: currentOutcome,
    message: messages[currentOutcome],
    errorCategory: safeText(result.errorCategory, '', 80),
    exitCode: result.exitCode,
    stdoutSummary: safeText(result.stdoutSummary),
    stderrSummary: safeText(result.stderrSummary),
    artifacts,
    artifactCount: result.artifacts.length
  }
}
