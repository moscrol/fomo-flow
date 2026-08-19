// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { CollaborationTask } from '@/components/collaboration/collaborationModel'
import { WorkItemArtifactPanel } from './WorkItemArtifactPanel'

describe('WorkItemArtifactPanel', () => {
  it('shows safe task facts and never exposes the job id or full path', () => {
    const task = {
      jobId: 'secret-task-id',
      status: 'succeeded',
      result: {
        status: 'succeeded',
        exitCode: 0,
        errorCategory: '',
        stdoutSummary: '完成 /Users/demo/project',
        stderrSummary: '',
        finishedAt: 1,
        artifacts: [{ ref: '/Users/demo/project/out.diff', kind: 'diff' }]
      }
    } as CollaborationTask
    render(<WorkItemArtifactPanel task={task} />)
    expect(screen.getByText('任务已完成，可以审阅产物。')).toBeInTheDocument()
    expect(screen.getByText('[路径已隐藏]')).toBeInTheDocument()
    expect(screen.queryByText('secret-task-id')).not.toBeInTheDocument()
    expect(screen.queryByText('/Users/demo/project/out.diff')).not.toBeInTheDocument()
  })
})
