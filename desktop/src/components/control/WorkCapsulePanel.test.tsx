// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { WorkCapsule } from '@/components/work/deskEventModel'
import type { WorkItem } from '@/components/work/workItemModel'
import { WorkCapsulePanel } from './WorkCapsulePanel'

function workItem(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    key: 'session:private-session',
    kind: 'session',
    bucket: 'active',
    source: 'DEVIN',
    title: '修复缓存观测',
    phase: '验证中',
    route: 'cccc · gpt-5.6',
    routeFacts: {
      provider: 'cccc',
      upstreamModel: 'gpt-5.6',
      modelUid: 'swe-1-6',
      provisional: false
    },
    profile: 'balanced',
    updatedAt: 9_000,
    tone: 'good',
    suggestion: '查看协作会话',
    pulse: { current: '整理验证结果', progress: '1 / 2 项完成', outcome: '测试通过' },
    target: { view: 'collaboration', id: 'private-session' },
    ...overrides
  }
}

function capsule(item: WorkItem): WorkCapsule {
  return {
    item,
    current: '整理验证结果',
    progress: '1 / 2 项完成',
    outcome: '测试通过',
    route: item.routeFacts,
    hasHandoff: true,
    events: [
      {
        key: 'event-safe',
        ownerKey: 'work-safe',
        at: 9_000,
        kind: 'lifecycle',
        state: 'running',
        actor: 'Devin',
        verb: '正在处理',
        object: '修复缓存观测',
        outcome: '进行中',
        detail: '验证中',
        importance: 'normal',
        source: 'session',
        evidence: { active: true }
      }
    ]
  }
}

afterEach(cleanup)

describe('WorkCapsulePanel', () => {
  it('shows direct session facts and navigates only from the explicit open action', async () => {
    const user = userEvent.setup()
    const onOpenItem = vi.fn()
    render(
      <WorkCapsulePanel
        capsule={capsule(workItem())}
        now={10_000}
        actionLoading={false}
        onOpenItem={onOpenItem}
        onAcknowledge={vi.fn()}
        onPromote={vi.fn()}
      />
    )

    expect(screen.getByRole('region', { name: '工作舱' })).toBeInTheDocument()
    expect(screen.getByText('现在在做：整理验证结果')).toBeInTheDocument()
    expect(screen.getByText('最近结果：测试通过')).toBeInTheDocument()
    expect(screen.getByText('来源 · DEVIN')).toBeInTheDocument()
    expect(screen.getByText('上游渠道 cccc · 上游模型 gpt-5.6')).toBeInTheDocument()
    expect(screen.getByText('路由配置名 swe-1-6')).toBeInTheDocument()
    expect(screen.getByText('已观测实际路由')).toBeInTheDocument()
    expect(screen.getByText('Devin 正在处理 修复缓存观测 → 进行中')).toBeInTheDocument()
    expect(
      screen
        .getByText('Devin 正在处理 修复缓存观测 → 进行中')
        .compareDocumentPosition(screen.getByText('上游渠道 cccc · 上游模型 gpt-5.6')) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    expect(document.body.textContent).not.toContain('private-session')

    await user.click(screen.getByRole('button', { name: '打开协作会话' }))
    expect(onOpenItem).toHaveBeenCalledTimes(1)
  })

  it('shows task and attention actions only when the selected work supports them', async () => {
    const user = userEvent.setup()
    const onAcknowledge = vi.fn()
    const onPromote = vi.fn()
    const item = workItem({
      key: 'task:private-job',
      kind: 'task',
      bucket: 'attention',
      fingerprint: 'opaque-fingerprint',
      attentionKind: 'failed',
      target: { view: 'tasks', id: 'private-job' },
      title: '构建桌面应用',
      source: 'CODEX'
    })
    render(
      <WorkCapsulePanel
        capsule={capsule(item)}
        now={10_000}
        actionLoading={false}
        onOpenItem={vi.fn()}
        onAcknowledge={onAcknowledge}
        onPromote={onPromote}
      >
        <p>任务产物入口</p>
      </WorkCapsulePanel>
    )

    expect(screen.getByText('任务产物入口')).toBeInTheDocument()
    expect(
      screen
        .getByText('任务产物入口')
        .compareDocumentPosition(screen.getByRole('button', { name: '打开任务进度' })) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    await user.click(screen.getByRole('button', { name: '我知道了' }))
    await user.click(screen.getByRole('button', { name: '加入任务板' }))
    expect(onAcknowledge).toHaveBeenCalledTimes(1)
    expect(onPromote).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: '打开任务进度' })).toBeInTheDocument()
  })

  it('does not claim an observed route when no route fact was reported', () => {
    const item = workItem({
      route: '路由尚未上报',
      routeFacts: {
        provider: '',
        upstreamModel: '',
        modelUid: '',
        provisional: false
      }
    })

    render(
      <WorkCapsulePanel
        capsule={capsule(item)}
        now={10_000}
        actionLoading={false}
        onOpenItem={vi.fn()}
        onAcknowledge={vi.fn()}
        onPromote={vi.fn()}
      />
    )

    expect(screen.getByText('路由尚未上报')).toBeInTheDocument()
    expect(screen.queryByText('已观测实际路由')).not.toBeInTheDocument()
  })
})
