import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { Readable, Writable } from 'node:stream'

import {
  PROTOCOL_VERSION,
  client,
  methods,
  ndJsonStream,
  type ClientConnection,
  type PromptResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionConfigOption,
  type SessionNotification
} from '@agentclientprotocol/sdk'

import { projectModelOptions } from './devin-acp-projection'

export type DevinAcpSession = {
  configOptions: SessionConfigOption[]
  currentModel: string
}

export type DevinAcpAdapter = {
  start(cwd: string): Promise<DevinAcpSession>
  selectModel(model: string): Promise<DevinAcpSession>
  prompt(prompt: string): Promise<PromptResponse>
  cancel(): Promise<void>
  stop(): Promise<void>
}

type AdapterInput = {
  child: ChildProcessWithoutNullStreams
  onPermission(request: RequestPermissionRequest): Promise<RequestPermissionResponse>
  onUpdate(update: SessionNotification): void | Promise<void>
}

export function createDevinAcpAdapter(input: AdapterInput): DevinAcpAdapter {
  let connection: ClientConnection | null = null
  let sessionId = ''
  let configOptions: SessionConfigOption[] = []
  let promptInFlight = false
  let stopped = false

  // Stderr may carry diagnostics, but it must not be logged because an agent
  // can include prompts, paths, commands, or credentials there.
  input.child.stderr.resume()

  function agent() {
    if (!connection || connection.signal.aborted) throw new Error('Devin ACP 连接不可用')
    return connection.agent
  }

  function session(): DevinAcpSession {
    const projected = projectModelOptions(configOptions)
    return { configOptions, currentModel: projected.currentValue }
  }

  return {
    async start(cwd) {
      if (stopped) throw new Error('Devin ACP 连接已停止')
      if (connection || sessionId) throw new Error('Devin ACP 会话已经创建')
      const app = client({ name: 'FOMO FLOW' })
        .onNotification(methods.client.session.update, ({ params }) => input.onUpdate(params))
        .onRequest(methods.client.session.requestPermission, ({ params }) =>
          input.onPermission(params)
        )
      connection = app.connect(
        ndJsonStream(
          Writable.toWeb(input.child.stdin) as WritableStream<Uint8Array>,
          Readable.toWeb(input.child.stdout) as ReadableStream<Uint8Array>
        )
      )
      await agent().request(methods.agent.initialize, {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: { session: { configOptions: {} } },
        clientInfo: { name: 'FOMO FLOW', version: '9.9.423' }
      })
      const created = await agent().request(methods.agent.session.new, {
        cwd,
        mcpServers: []
      })
      sessionId = created.sessionId
      configOptions = Array.isArray(created.configOptions) ? created.configOptions : []
      return session()
    },

    async selectModel(model) {
      if (!sessionId) throw new Error('请先创建 Devin ACP 会话')
      const projected = projectModelOptions(configOptions)
      if (!projected.options.some((option) => option.value === model)) {
        throw new Error('模型选项无效')
      }
      const response = await agent().request(methods.agent.session.setConfigOption, {
        sessionId,
        configId: 'model',
        value: model
      })
      configOptions = response.configOptions
      return session()
    },

    async prompt(prompt) {
      if (!sessionId) throw new Error('请先创建 Devin ACP 会话')
      if (promptInFlight) throw new Error('Devin 正在处理上一条任务')
      promptInFlight = true
      try {
        return await agent().request(methods.agent.session.prompt, {
          sessionId,
          prompt: [{ type: 'text', text: prompt }]
        })
      } finally {
        promptInFlight = false
      }
    },

    async cancel() {
      if (!sessionId || !connection || connection.signal.aborted) return
      await agent().notify(methods.agent.session.cancel, { sessionId })
    },

    async stop() {
      if (stopped) return
      stopped = true
      try {
        if (sessionId && connection && !connection.signal.aborted) {
          await agent()
            .notify(methods.agent.session.cancel, { sessionId })
            .catch(() => undefined)
        }
      } finally {
        connection?.close()
        connection = null
        sessionId = ''
        if (!input.child.stdin.destroyed && !input.child.stdin.writableEnded)
          input.child.stdin.end()
      }
    }
  }
}
