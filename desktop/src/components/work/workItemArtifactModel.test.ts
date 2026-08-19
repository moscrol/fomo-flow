import { describe, expect, it } from 'vitest'
import { normalizeTask } from '@/components/collaboration/collaborationModel'
import { projectTaskArtifactReview } from './workItemArtifactModel'

describe('projectTaskArtifactReview', () => {
  it('explains completed, failed and empty artifact outcomes plainly', () => {
    const done = projectTaskArtifactReview(
      normalizeTask({
        status: 'succeeded',
        result: {
          status: 'success',
          exitCode: 0,
          artifacts: [{ path: '/Users/a/report.html', kind: 'report' }]
        }
      })
    )
    expect(done.outcome).toBe('completed')
    expect(done.message).toContain('完成')
    expect(done.artifacts).toEqual([{ ref: 'report.html', kind: 'report' }])

    const failed = projectTaskArtifactReview(
      normalizeTask({
        status: 'failed',
        result: { status: 'failed', exitCode: 1, errorCategory: 'timeout', stderrSummary: 'failed' }
      })
    )
    expect(failed.outcome).toBe('failed')
    expect(failed.message).toContain('失败')

    const empty = projectTaskArtifactReview(
      normalizeTask({ status: 'succeeded', result: { status: 'success', exitCode: 0 } })
    )
    expect(empty.outcome).toBe('empty')
    expect(empty.message).toContain('产物')
  })

  it('bounds fields, redacts sensitive values and never exposes ids or commands', () => {
    const task = normalizeTask({
      id: 'job-secret-123',
      command: 'curl -H "Authorization: Bearer supersecret" /Users/private/x',
      status: 'failed',
      result: {
        status: 'failed',
        errorCategory: 'Bearer abc123 /Users/private/dao',
        stdoutSummary: 'x'.repeat(400),
        stderrSummary: 'sk-secret-value',
        artifacts: Array.from({ length: 30 }, (_, index) => ({
          path: `/tmp/artifact-${index}.txt`,
          kind: 'text'
        }))
      }
    })
    const review = projectTaskArtifactReview(task)
    expect(review.artifacts).toHaveLength(20)
    expect(review.errorCategory).not.toContain('Bearer')
    expect(review.stderrSummary).toContain('[凭据已隐藏]')
    expect(review.stdoutSummary.length).toBeLessThanOrEqual(220)
    expect(JSON.stringify(review)).not.toContain('job-secret-123')
    expect(JSON.stringify(review)).not.toContain('curl')
    expect(JSON.stringify(review)).not.toContain('/tmp/')
  })

  it('shares the same broad local-path and authorization redaction policy', () => {
    const review = projectTaskArtifactReview(
      normalizeTask({
        status: 'failed',
        result: {
          errorCategory: 'Authorization: Digest abc /etc/dao',
          stderrSummary: '/var/log/dao /opt/dao /home/dao /Users/dao C:/Users/dao'
        }
      })
    )
    const rendered = JSON.stringify(review)
    expect(rendered).not.toMatch(/Digest\s+abc|\/(?:etc|var|opt|home|Users)\//i)
    expect(rendered).not.toContain('C:/Users/dao')
    expect(rendered).toContain('[凭据已隐藏]')
    expect(rendered).toContain('[路径已隐藏]')
  })
})
