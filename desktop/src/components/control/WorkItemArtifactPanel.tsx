import { projectTaskArtifactReview } from '@/components/work/workItemArtifactModel'
import type { CollaborationTask } from '@/components/collaboration/collaborationModel'
import { ControlListEmpty, ControlPanel } from './ControlPrimitives'

export function WorkItemArtifactPanel({ task }: { task: CollaborationTask }) {
  const review = projectTaskArtifactReview(task)
  return (
    <ControlPanel title="任务产物与终端事实" note="只读安全摘要">
      <div className="work-artifact-panel">
        <p className="empty-note">{review.message}</p>
        {review.outcome === 'failed' && review.errorCategory && (
          <p className="work-artifact-fact">失败类型：{review.errorCategory}</p>
        )}
        {review.exitCode !== null && (
          <p className="work-artifact-fact">
            退出状态：{review.exitCode === 0 ? '正常' : `异常（${review.exitCode}）`}
          </p>
        )}
        {review.stdoutSummary && (
          <p className="work-artifact-fact">完成摘要：{review.stdoutSummary}</p>
        )}
        {review.stderrSummary && (
          <p className="work-artifact-fact">错误摘要：{review.stderrSummary}</p>
        )}
        {review.artifacts.length ? (
          <div className="work-artifact-list" role="list" aria-label="任务产物">
            {review.artifacts.map((artifact, index) => (
              <div className="work-artifact" role="listitem" key={`${artifact.ref}-${index}`}>
                <strong>{artifact.ref}</strong>
                <small>{artifact.kind}</small>
              </div>
            ))}
            {review.artifactCount > review.artifacts.length && (
              <small>还有 {review.artifactCount - review.artifacts.length} 项产物未展开</small>
            )}
          </div>
        ) : (
          <ControlListEmpty label="没有可展示的产物引用。" />
        )}
      </div>
    </ControlPanel>
  )
}
