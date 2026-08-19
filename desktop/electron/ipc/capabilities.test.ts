import { describe, expect, it } from 'vitest'

import { ELECTRON_IPC_CHANNELS } from './channels'
import { validateDesktopIpcPayload } from './capabilities'

describe('Dao Desktop IPC capabilities', () => {
  it('accepts only the fixed, safe payload shapes', () => {
    expect(validateDesktopIpcPayload(ELECTRON_IPC_CHANNELS.runtimeStatus, undefined)).toBe(true)
    expect(validateDesktopIpcPayload(ELECTRON_IPC_CHANNELS.runtimeRetry, undefined)).toBe(true)
    expect(validateDesktopIpcPayload(ELECTRON_IPC_CHANNELS.taskboardSnapshot, undefined)).toBe(true)
    expect(validateDesktopIpcPayload(ELECTRON_IPC_CHANNELS.taskboardConnect, undefined)).toBe(true)
    expect(
      validateDesktopIpcPayload(ELECTRON_IPC_CHANNELS.channelMigrationPreview, undefined)
    ).toBe(true)
    expect(
      validateDesktopIpcPayload(ELECTRON_IPC_CHANNELS.channelMigrationApply, {
        confirmationToken: '07'.repeat(32)
      })
    ).toBe(true)
    expect(
      validateDesktopIpcPayload(ELECTRON_IPC_CHANNELS.shellOpenExternal, {
        url: 'https://example.com/account'
      })
    ).toBe(true)
    expect(
      validateDesktopIpcPayload(ELECTRON_IPC_CHANNELS.clipboardWrite, {
        text: 'http://127.0.0.1:8955/v1'
      })
    ).toBe(true)
    expect(
      validateDesktopIpcPayload(ELECTRON_IPC_CHANNELS.controlSaveHandoff, {
        content: '# FOMO FLOW\n',
        filename: 'fomo-flow-handoff.md'
      })
    ).toBe(true)
    expect(
      validateDesktopIpcPayload(ELECTRON_IPC_CHANNELS.controlRequest, {
        path: '/origin/ea/overview',
        method: 'GET'
      })
    ).toBe(true)
    expect(
      validateDesktopIpcPayload(ELECTRON_IPC_CHANNELS.workAttentionResolved, {
        fingerprints: ['0123456789abcdef0123456789abcdef']
      })
    ).toBe(true)
    expect(
      validateDesktopIpcPayload(ELECTRON_IPC_CHANNELS.workAttentionResolve, {
        fingerprint: '0123456789abcdef0123456789abcdef',
        resolution: 'acknowledged'
      })
    ).toBe(true)
    expect(validateDesktopIpcPayload(ELECTRON_IPC_CHANNELS.devinHostStatus, undefined)).toBe(true)
    expect(
      validateDesktopIpcPayload(ELECTRON_IPC_CHANNELS.devinHostChooseWorkspace, undefined)
    ).toBe(true)
    expect(
      validateDesktopIpcPayload(ELECTRON_IPC_CHANNELS.devinHostStart, {
        workspaceHandle: '01'.repeat(16)
      })
    ).toBe(true)
    expect(
      validateDesktopIpcPayload(ELECTRON_IPC_CHANNELS.devinNativeOpen, {
        workspaceHandle: '01'.repeat(16)
      })
    ).toBe(true)
    expect(
      validateDesktopIpcPayload(ELECTRON_IPC_CHANNELS.devinHostPrompt, {
        prompt: 'Fix the focused test',
        model: 'dao-gpt-5-6-sol'
      })
    ).toBe(true)
    expect(
      validateDesktopIpcPayload(ELECTRON_IPC_CHANNELS.devinHostPermission, {
        permissionId: '02'.repeat(16),
        decision: 'allow_once'
      })
    ).toBe(true)
    expect(validateDesktopIpcPayload(ELECTRON_IPC_CHANNELS.devinHostCancel, undefined)).toBe(true)
    expect(validateDesktopIpcPayload(ELECTRON_IPC_CHANNELS.devinHostStop, undefined)).toBe(true)
    expect(
      validateDesktopIpcPayload(ELECTRON_IPC_CHANNELS.taskboardCreate, {
        fingerprint: '0'.repeat(32),
        title: '构建失败',
        sourceKind: 'task',
        failureKind: 'failed',
        acceptance: '修复后完成一次验证。'
      })
    ).toBe(true)
    expect(
      validateDesktopIpcPayload(ELECTRON_IPC_CHANNELS.workAttentionResolve, {
        fingerprint: '0123456789abcdef0123456789abcdef',
        resolution: 'promoted',
        taskIdentifier: 'DAOFLOW-123'
      })
    ).toBe(true)
  })

  it('rejects filesystem, command, malformed, and oversized payloads', () => {
    expect(
      validateDesktopIpcPayload(ELECTRON_IPC_CHANNELS.shellOpenExternal, {
        url: 'file:///etc/passwd'
      })
    ).toBe(false)
    expect(
      validateDesktopIpcPayload('dao:arbitrary-command' as never, {
        command: 'open /Applications'
      })
    ).toBe(false)
    expect(
      validateDesktopIpcPayload(ELECTRON_IPC_CHANNELS.clipboardWrite, {
        text: 'x'.repeat(1_000_001)
      })
    ).toBe(false)
    expect(
      validateDesktopIpcPayload(ELECTRON_IPC_CHANNELS.controlSaveHandoff, {
        content: '# FOMO FLOW',
        filename: '../escape.md'
      })
    ).toBe(false)
    expect(
      validateDesktopIpcPayload(ELECTRON_IPC_CHANNELS.controlRequest, {
        path: 'https://example.test',
        method: 'GET'
      })
    ).toBe(false)
    expect(
      validateDesktopIpcPayload(ELECTRON_IPC_CHANNELS.controlSaveHandoff, {
        content: 'x'.repeat(2_000_001),
        filename: 'handoff.md'
      })
    ).toBe(false)
    expect(
      validateDesktopIpcPayload(ELECTRON_IPC_CHANNELS.workAttentionResolved, {
        fingerprints: ['private-job-id']
      })
    ).toBe(false)
    expect(
      validateDesktopIpcPayload(ELECTRON_IPC_CHANNELS.workAttentionResolved, {
        fingerprints: Array.from({ length: 201 }, () => '0'.repeat(32))
      })
    ).toBe(false)
    expect(
      validateDesktopIpcPayload(ELECTRON_IPC_CHANNELS.workAttentionResolve, {
        fingerprint: '0'.repeat(32),
        resolution: 'acknowledged',
        path: '/Users/private/project'
      })
    ).toBe(false)
    expect(
      validateDesktopIpcPayload(ELECTRON_IPC_CHANNELS.workAttentionResolve, {
        fingerprint: '0'.repeat(32),
        resolution: 'promoted',
        taskIdentifier: 'DAOFLOW-123 prompt'
      })
    ).toBe(false)
    expect(
      validateDesktopIpcPayload(ELECTRON_IPC_CHANNELS.taskboardConnect, {
        descriptorPath: '/Users/private/launcher-runtime.json'
      })
    ).toBe(false)
    expect(
      validateDesktopIpcPayload(ELECTRON_IPC_CHANNELS.taskboardCreate, {
        fingerprint: '0'.repeat(32),
        title: '构建失败',
        sourceKind: 'task',
        failureKind: 'failed',
        acceptance: '修复后完成一次验证。',
        prompt: 'private prompt',
        path: '/Users/private/project'
      })
    ).toBe(false)
    expect(
      validateDesktopIpcPayload(ELECTRON_IPC_CHANNELS.channelMigrationPreview, {
        sourcePath: '/Users/private/配置.json'
      })
    ).toBe(false)
    expect(
      validateDesktopIpcPayload(ELECTRON_IPC_CHANNELS.channelMigrationApply, {
        confirmationToken: '07'.repeat(32),
        destinationPath: '/Users/private/配置.json'
      })
    ).toBe(false)
    expect(
      validateDesktopIpcPayload(ELECTRON_IPC_CHANNELS.channelMigrationApply, {
        confirmationToken: 'GG'.repeat(32)
      })
    ).toBe(false)
    expect(
      validateDesktopIpcPayload(ELECTRON_IPC_CHANNELS.devinHostStart, {
        workspaceHandle: '01'.repeat(16),
        command: '/bin/sh'
      })
    ).toBe(false)
    expect(
      validateDesktopIpcPayload(ELECTRON_IPC_CHANNELS.devinHostStart, {
        workspaceHandle: '/Users/private/workspace'
      })
    ).toBe(false)
    expect(
      validateDesktopIpcPayload(ELECTRON_IPC_CHANNELS.devinNativeOpen, {
        workspaceHandle: '/Users/private/workspace'
      })
    ).toBe(false)
    expect(
      validateDesktopIpcPayload(ELECTRON_IPC_CHANNELS.devinNativeOpen, {
        workspaceHandle: '01'.repeat(16),
        command: '/bin/sh'
      })
    ).toBe(false)
    expect(
      validateDesktopIpcPayload(ELECTRON_IPC_CHANNELS.devinHostPrompt, {
        prompt: 'x'.repeat(65_537)
      })
    ).toBe(false)
    expect(
      validateDesktopIpcPayload(ELECTRON_IPC_CHANNELS.devinHostPrompt, {
        prompt: 'safe',
        model: '/bin/sh'
      })
    ).toBe(false)
    expect(
      validateDesktopIpcPayload(ELECTRON_IPC_CHANNELS.devinHostPermission, {
        permissionId: '02'.repeat(16),
        decision: 'allow_always'
      })
    ).toBe(false)
    expect(
      validateDesktopIpcPayload(ELECTRON_IPC_CHANNELS.devinHostPermission, {
        permissionId: 'raw-acp-request-id',
        decision: 'reject'
      })
    ).toBe(false)
    expect(validateDesktopIpcPayload(ELECTRON_IPC_CHANNELS.devinHostEvent, undefined)).toBe(false)
  })
})
