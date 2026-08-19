import { describe, expect, it } from 'vitest'

import { isDevinHostSnapshot, type DevinHostSnapshot } from '../../src/lib/desktopHost/devinAcpHost'
import {
  appendBoundedHostEvent,
  projectAcpUpdate,
  projectModelOptions,
  projectPermission
} from './devin-acp-projection'

describe('Devin ACP safe projection', () => {
  it('projects text without prompt echoes, credentials, paths, or raw protocol ids', () => {
    const event = projectAcpUpdate(
      {
        sessionId: 'session-raw-1',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: {
            type: 'text',
            text: 'private prompt Authorization: AWS4-HMAC-SHA256 Credential=AKIA, Signature=SECRET /Users/a77/private'
          },
          messageId: 'message-raw-1'
        }
      },
      1_700_000_000_000,
      { prompt: 'private prompt', id: () => 'a'.repeat(32) }
    )

    expect(event).toEqual({
      id: 'a'.repeat(32),
      kind: 'message',
      message: '[任务内容已隐藏] Authorization: [凭据已隐藏]',
      status: 'info',
      at: 1_700_000_000_000
    })
    expect(JSON.stringify(event)).not.toContain('session-raw-1')
    expect(JSON.stringify(event)).not.toContain('message-raw-1')
    expect(JSON.stringify(event)).not.toContain('AKIA')
    expect(JSON.stringify(event)).not.toContain('/Users/a77')
  })

  it('uses fixed tool categories and ignores raw input, output, locations, and commands', () => {
    const event = projectAcpUpdate(
      {
        sessionUpdate: 'tool_call',
        toolCallId: 'tool-raw',
        title: 'rm -rf /private/work',
        kind: 'execute',
        status: 'in_progress',
        rawInput: { command: 'rm -rf /private/work' },
        rawOutput: 'Authorization: Basic secret',
        locations: [{ path: '/private/work' }]
      },
      100,
      { id: () => 'b'.repeat(32) }
    )

    expect(event).toMatchObject({ kind: 'tool', message: '运行本地命令', status: 'running' })
    expect(JSON.stringify(event)).not.toContain('rm -rf')
    expect(JSON.stringify(event)).not.toContain('tool-raw')
    expect(JSON.stringify(event)).not.toContain('/private')
    expect(JSON.stringify(event)).not.toContain('Basic')
  })

  it('projects only bounded model select values from the model category', () => {
    const models = projectModelOptions([
      {
        id: 'model',
        category: 'model',
        type: 'select',
        currentValue: 'dao-gpt-5-6-sol',
        options: [
          { value: 'dao-gpt-5-6-sol', name: 'Dao GPT 5.6 Sol' },
          { value: '/bin/sh', name: 'unsafe' },
          {
            group: 'other',
            name: 'Other',
            options: [{ value: 'dao-opus-5', name: 'Dao Opus 5' }]
          }
        ]
      },
      { id: 'thought', category: 'thought_level', type: 'select', options: [] }
    ])

    expect(models).toEqual({
      currentValue: 'dao-gpt-5-6-sol',
      options: [
        { value: 'dao-gpt-5-6-sol', label: 'Dao GPT 5.6 Sol' },
        { value: 'dao-opus-5', label: 'Dao Opus 5' }
      ]
    })
  })

  it('projects permission without raw option ids, commands, or always-allow', () => {
    const projected = projectPermission(
      {
        sessionId: 'session-private',
        toolCall: {
          toolCallId: 'tool-private',
          kind: 'edit',
          title: 'Edit /etc/secret',
          rawInput: { command: 'cat /etc/secret' }
        },
        options: [
          { optionId: 'raw-allow-once', name: 'Allow', kind: 'allow_once' },
          { optionId: 'raw-allow-always', name: 'Always', kind: 'allow_always' },
          { optionId: 'raw-reject', name: 'Reject', kind: 'reject_once' }
        ]
      },
      'c'.repeat(32)
    )

    expect(projected).toEqual({
      id: 'c'.repeat(32),
      category: '修改文件',
      message: 'Devin 请求修改文件。请确认是否只允许这一次。',
      allowOnce: true
    })
    expect(JSON.stringify(projected)).not.toContain('raw-')
    expect(JSON.stringify(projected)).not.toContain('/etc')
  })

  it('keeps only the latest 200 safe events and reports dropped count', () => {
    let state = { events: [], droppedEventCount: 0 } as Pick<
      DevinHostSnapshot,
      'events' | 'droppedEventCount'
    >
    for (let index = 0; index < 250; index += 1) {
      state = appendBoundedHostEvent(state, {
        id: index.toString(16).padStart(32, '0'),
        kind: 'status',
        message: `safe-${index}`,
        status: 'info',
        at: index
      })
    }
    expect(state.events).toHaveLength(200)
    expect(state.events[0].message).toBe('safe-50')
    expect(state.droppedEventCount).toBe(50)
  })

  it('rejects snapshots with unknown fields or invalid local handles', () => {
    const valid: DevinHostSnapshot = {
      phase: 'ready',
      runtimeHealthy: true,
      devinAvailable: true,
      models: [],
      selectedModel: '',
      events: [],
      droppedEventCount: 0
    }
    expect(isDevinHostSnapshot(valid)).toBe(true)
    expect(isDevinHostSnapshot({ ...valid, rawSessionId: 'session-private' })).toBe(false)
    expect(
      isDevinHostSnapshot({ ...valid, workspace: { handle: '/tmp/work', label: 'work' } })
    ).toBe(false)
  })
})
