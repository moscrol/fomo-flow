import { randomBytes } from 'node:crypto'

import { sanitizeDisplayText } from '../../src/components/work/displaySanitizer'
import type {
  DevinHostEvent,
  DevinHostModelOption,
  DevinHostPermission,
  DevinHostSnapshot
} from '../../src/lib/desktopHost/devinAcpHost'

const MODEL_VALUE = /^[A-Za-z0-9._:-]{1,120}$/
const MAX_EVENTS = 200

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function localId(): string {
  return randomBytes(16).toString('hex')
}

function escaped(value: string): RegExp {
  return new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')
}

function safeMessage(value: unknown, prompt = '', fallback = ''): string {
  const raw = typeof value === 'string' || typeof value === 'number' ? String(value) : ''
  const withoutPrompt = prompt.trim()
    ? raw.replace(escaped(prompt.trim()), '[任务内容已隐藏]')
    : raw
  return sanitizeDisplayText(withoutPrompt, fallback, 2_000)
}

function updateRecord(value: unknown): Record<string, unknown> | null {
  const root = record(value)
  return record(root?.update) ?? root
}

function contentText(value: unknown): string {
  const content = record(value)
  return content?.type === 'text' && typeof content.text === 'string' ? content.text : ''
}

function toolCategory(kind: unknown): DevinHostPermission['category'] {
  if (kind === 'read' || kind === 'search' || kind === 'fetch') return '读取文件'
  if (kind === 'edit' || kind === 'delete' || kind === 'move') return '修改文件'
  if (kind === 'execute') return '运行本地命令'
  return '使用工具'
}

function eventStatus(value: unknown): DevinHostEvent['status'] {
  if (value === 'in_progress' || value === 'pending') return 'running'
  if (value === 'completed') return 'completed'
  if (value === 'failed') return 'failed'
  return 'info'
}

export function projectAcpUpdate(
  value: unknown,
  at: number,
  options: { prompt?: string; id?: () => string } = {}
): DevinHostEvent | null {
  const update = updateRecord(value)
  if (!update || typeof update.sessionUpdate !== 'string') return null
  const id = (options.id ?? localId)()
  const prompt = options.prompt ?? ''

  switch (update.sessionUpdate) {
    case 'agent_message_chunk': {
      const message = safeMessage(contentText(update.content), prompt)
      return message ? { id, kind: 'message', message, status: 'info', at } : null
    }
    case 'agent_thought_chunk':
      return { id, kind: 'thought', message: 'Devin 正在分析任务。', status: 'running', at }
    case 'tool_call':
    case 'tool_call_update':
      return {
        id,
        kind: 'tool',
        message: toolCategory(update.kind),
        status: eventStatus(update.status),
        at
      }
    case 'plan': {
      const entries = Array.isArray(update.entries) ? update.entries : []
      const current =
        entries.map(record).find((entry) => entry?.status === 'in_progress') ??
        entries.map(record).find(Boolean)
      const message = safeMessage(current?.content, prompt, 'Devin 已更新执行计划。')
      return { id, kind: 'plan', message, status: eventStatus(current?.status), at }
    }
    case 'usage_update': {
      const used = Number(update.used)
      const size = Number(update.size)
      if (!Number.isFinite(used) || !Number.isFinite(size)) return null
      return {
        id,
        kind: 'usage',
        message: `上下文已使用 ${Math.max(0, Math.round(used))} / ${Math.max(0, Math.round(size))} tokens`,
        status: 'info',
        at
      }
    }
    default:
      // user_message_chunk and identity/config protocol updates are deliberately not rendered.
      return null
  }
}

function flattenSelectOptions(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return []
  const flattened: Array<Record<string, unknown>> = []
  for (const item of value) {
    const option = record(item)
    if (!option) continue
    if (Array.isArray(option.options)) flattened.push(...flattenSelectOptions(option.options))
    else flattened.push(option)
  }
  return flattened
}

export function projectModelOptions(value: unknown): {
  currentValue: string
  options: DevinHostModelOption[]
} {
  if (!Array.isArray(value)) return { currentValue: '', options: [] }
  const model = value
    .map(record)
    .find(
      (option) =>
        option?.type === 'select' && (option.category === 'model' || option.id === 'model')
    )
  if (!model) return { currentValue: '', options: [] }
  const seen = new Set<string>()
  const options: DevinHostModelOption[] = []
  for (const raw of flattenSelectOptions(model.options)) {
    const candidate = typeof raw.value === 'string' ? raw.value : ''
    if (!MODEL_VALUE.test(candidate) || seen.has(candidate)) continue
    seen.add(candidate)
    options.push({
      value: candidate,
      label: sanitizeDisplayText(raw.name, candidate, 160)
    })
    if (options.length === 50) break
  }
  const currentValue =
    typeof model.currentValue === 'string' && MODEL_VALUE.test(model.currentValue)
      ? model.currentValue
      : ''
  return { currentValue, options }
}

export function projectPermission(value: unknown, id = localId()): DevinHostPermission {
  const root = record(value)
  const toolCall = record(root?.toolCall)
  const category = toolCategory(toolCall?.kind)
  const options = Array.isArray(root?.options) ? root.options.map(record).filter(Boolean) : []
  return {
    id,
    category,
    message: `Devin 请求${category}。请确认是否只允许这一次。`,
    allowOnce: options.some((option) => option?.kind === 'allow_once')
  }
}

export function appendBoundedHostEvent(
  state: Pick<DevinHostSnapshot, 'events' | 'droppedEventCount'>,
  event: DevinHostEvent
): Pick<DevinHostSnapshot, 'events' | 'droppedEventCount'> {
  const events = [...state.events, event]
  const dropped = Math.max(0, events.length - MAX_EVENTS)
  return {
    events: dropped ? events.slice(dropped) : events,
    droppedEventCount: state.droppedEventCount + dropped
  }
}
