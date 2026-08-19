import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { RequestPermissionRequest, RequestPermissionResponse } from '@agentclientprotocol/sdk'
import { createDevinAcpAdapter, type DevinAcpAdapter } from './devin-acp-adapter'

const fixturePath = fileURLToPath(new URL('./fixtures/fake-devin-acp-agent.mjs', import.meta.url))
const adapters: DevinAcpAdapter[] = []

afterEach(async () => {
  await Promise.all(adapters.splice(0).map((adapter) => adapter.stop()))
})

function startAdapter(
  onPermission: (request: RequestPermissionRequest) => Promise<RequestPermissionResponse>
) {
  const child = spawn(process.execPath, [fixturePath], {
    stdio: ['pipe', 'pipe', 'pipe']
  })
  const onUpdate = vi.fn()
  const adapter = createDevinAcpAdapter({ child, onPermission, onUpdate })
  adapters.push(adapter)
  return { adapter, child, onUpdate }
}

describe('Devin ACP adapter', () => {
  it('initializes, creates a session, selects a returned model and streams updates', async () => {
    const permissionRequests: RequestPermissionRequest[] = []
    const { adapter, onUpdate } = startAdapter(async (request) => {
      permissionRequests.push(request)
      const allow = request.options.find((option) => option.kind === 'allow_once')
      return allow
        ? { outcome: { outcome: 'selected', optionId: allow.optionId } }
        : { outcome: { outcome: 'cancelled' } }
    })

    const session = await adapter.start('/tmp/acp-safe-workspace')
    expect(session.currentModel).toBe('dao-gpt-5-6-sol')
    expect(session.configOptions).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'model', category: 'model' })])
    )

    const selected = await adapter.selectModel('dao-opus-5')
    expect(selected.currentModel).toBe('dao-opus-5')
    await expect(adapter.prompt('fixture prompt')).resolves.toMatchObject({
      stopReason: 'end_turn'
    })
    expect(permissionRequests).toHaveLength(1)
    expect(onUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ sessionUpdate: 'agent_message_chunk' })
      })
    )
    expect(JSON.stringify(onUpdate.mock.calls)).toContain('fixture response via dao-opus-5')
  })

  it('rejects model values not returned by the ACP session', async () => {
    const { adapter } = startAdapter(async () => ({ outcome: { outcome: 'cancelled' } }))
    await adapter.start('/tmp/acp-safe-workspace')
    await expect(adapter.selectModel('/bin/sh')).rejects.toThrow('模型选项无效')
  })

  it('forwards cancel and rejects malformed prompt turns without hanging', async () => {
    let resolvePermission: ((response: RequestPermissionResponse) => void) | undefined
    const { adapter } = startAdapter(
      () =>
        new Promise<RequestPermissionResponse>((resolve) => {
          resolvePermission = resolve
        })
    )
    await adapter.start('/tmp/acp-safe-workspace')
    const prompt = adapter.prompt('fixture prompt')
    await vi.waitFor(() => expect(resolvePermission).toBeTypeOf('function'))
    await adapter.cancel()
    resolvePermission?.({ outcome: { outcome: 'cancelled' } })
    await expect(prompt).resolves.toMatchObject({ stopReason: 'cancelled' })

    await expect(adapter.prompt('protocol-error')).rejects.toThrow()
  })

  it('closes the ACP connection and child pipes idempotently', async () => {
    const { adapter, child } = startAdapter(async () => ({ outcome: { outcome: 'cancelled' } }))
    await adapter.start('/tmp/acp-safe-workspace')
    await adapter.stop()
    await adapter.stop()
    expect(child.stdin.destroyed || child.stdin.writableEnded).toBe(true)
  })
})
