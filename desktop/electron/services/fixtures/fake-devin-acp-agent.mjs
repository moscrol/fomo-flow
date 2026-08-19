import { PROTOCOL_VERSION, agent, methods, ndJsonStream } from '@agentclientprotocol/sdk'
import { Readable, Writable } from 'node:stream'

const sessionId = 'fake-devin-session-private'
let selectedModel = 'dao-gpt-5-6-sol'
let cancelled = false

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function modelOptions() {
  return [
    {
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue: selectedModel,
      options: [
        { value: 'dao-gpt-5-6-sol', name: 'Dao GPT 5.6 Sol' },
        { value: 'dao-opus-5', name: 'Dao Opus 5' }
      ]
    }
  ]
}

const app = agent({ name: 'FOMO FLOW fake Devin' })
  .onRequest(methods.agent.initialize, ({ params }) => ({
    protocolVersion: params.protocolVersion || PROTOCOL_VERSION,
    agentCapabilities: { loadSession: false },
    authMethods: []
  }))
  .onRequest(methods.agent.session.new, () => ({ sessionId, configOptions: modelOptions() }))
  .onRequest(methods.agent.session.setConfigOption, ({ params }) => {
    if (params.configId !== 'model' || !['dao-gpt-5-6-sol', 'dao-opus-5'].includes(params.value)) {
      throw new Error('invalid model')
    }
    selectedModel = params.value
    return { configOptions: modelOptions() }
  })
  .onNotification(methods.agent.session.cancel, () => {
    cancelled = true
  })
  .onRequest(methods.agent.session.prompt, async (context) => {
    const text = context.params.prompt
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join(' ')
    if (text === 'protocol-error') throw new Error('fixture protocol failure')
    await context.client.notify(methods.client.session.update, {
      sessionId,
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'fake-tool-private',
        title: 'Run fixture command /private/fixture',
        kind: 'execute',
        status: 'pending',
        rawInput: { command: 'echo fixture-secret' }
      }
    })
    const permission = await context.client.request(methods.client.session.requestPermission, {
      sessionId,
      toolCall: {
        toolCallId: 'fake-tool-private',
        title: 'Run fixture command /private/fixture',
        kind: 'execute',
        status: 'pending',
        rawInput: { command: 'echo fixture-secret' }
      },
      options: [
        { optionId: 'fake-allow', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'fake-always', name: 'Always allow', kind: 'allow_always' },
        { optionId: 'fake-reject', name: 'Reject', kind: 'reject_once' }
      ]
    })
    const allowed =
      permission.outcome.outcome === 'selected' && permission.outcome.optionId === 'fake-allow'
    await context.client.notify(methods.client.session.update, {
      sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: {
          type: 'text',
          text: cancelled
            ? 'fixture cancelled'
            : allowed
              ? `fixture response via ${selectedModel}`
              : 'fixture rejected'
        }
      }
    })
    return { stopReason: cancelled ? 'cancelled' : 'end_turn' }
  })

const connection = app.connect(
  ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin))
)

await connection.closed
