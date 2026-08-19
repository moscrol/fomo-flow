import type { ElectronIpcChannel } from './channels'

import { isAllowedDaoControlRequest } from '../services/dao-control'

const MAX_TEXT_LENGTH = 1_000_000
const MAX_URL_LENGTH = 4_096
const MAX_HANDOFF_LENGTH = 2_000_000
const MAX_FILENAME_LENGTH = 120
const WORK_FINGERPRINT = /^[a-f0-9]{32,128}$/
const TASK_IDENTIFIER = /^[A-Z][A-Z0-9]{1,30}-[1-9][0-9]{0,11}$/
const CHANNEL_MIGRATION_TOKEN = /^[a-f0-9]{64}$/
const DEVIN_HOST_HANDLE = /^[a-f0-9]{32}$/
const DEVIN_HOST_MODEL = /^[A-Za-z0-9._:-]{1,120}$/
const MAX_DEVIN_PROMPT_LENGTH = 65_536

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_URL_LENGTH) return false
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

function isTextPayload(value: unknown): value is { text: string } {
  return (
    isRecord(value) &&
    typeof value.text === 'string' &&
    value.text.length <= MAX_TEXT_LENGTH &&
    Object.keys(value).every((key) => key === 'text')
  )
}

function isHandoffPayload(value: unknown): value is { content: string; filename?: string } {
  if (
    !isRecord(value) ||
    typeof value.content !== 'string' ||
    value.content.length > MAX_HANDOFF_LENGTH
  ) {
    return false
  }
  if (Object.keys(value).some((key) => key !== 'content' && key !== 'filename')) return false
  if (value.filename === undefined) return true
  return (
    typeof value.filename === 'string' &&
    value.filename.length > 0 &&
    value.filename.length <= MAX_FILENAME_LENGTH &&
    /^[a-zA-Z0-9][a-zA-Z0-9._-]*\.md$/i.test(value.filename)
  )
}

function isWorkFingerprintList(value: unknown): boolean {
  return (
    isRecord(value) &&
    Object.keys(value).length === 1 &&
    Array.isArray(value.fingerprints) &&
    value.fingerprints.length <= 200 &&
    value.fingerprints.every(
      (fingerprint) => typeof fingerprint === 'string' && WORK_FINGERPRINT.test(fingerprint)
    )
  )
}

function isWorkResolution(value: unknown): boolean {
  if (
    !isRecord(value) ||
    typeof value.fingerprint !== 'string' ||
    !WORK_FINGERPRINT.test(value.fingerprint)
  ) {
    return false
  }
  if (value.resolution === 'acknowledged') {
    return Object.keys(value).length === 2 && value.taskIdentifier === undefined
  }
  return (
    value.resolution === 'promoted' &&
    Object.keys(value).length === 3 &&
    typeof value.taskIdentifier === 'string' &&
    TASK_IDENTIFIER.test(value.taskIdentifier)
  )
}

function containsPrivateWorkText(value: string): boolean {
  return /\bAuthorization\s*:|\bBearer\s+|\bsk-|\bfile:\/\/\/|(?:^|\s)\/[A-Za-z0-9._~-]+\/|\b[A-Za-z]:[\\/]/i.test(
    value
  )
}

function isTaskboardCreate(value: unknown): boolean {
  if (!isRecord(value) || Object.keys(value).length !== 5) return false
  const allowed = ['fingerprint', 'title', 'sourceKind', 'failureKind', 'acceptance']
  if (Object.keys(value).some((key) => !allowed.includes(key))) return false
  return (
    typeof value.fingerprint === 'string' &&
    WORK_FINGERPRINT.test(value.fingerprint) &&
    typeof value.title === 'string' &&
    value.title.length <= 180 &&
    !containsPrivateWorkText(value.title) &&
    (value.sourceKind === 'session' || value.sourceKind === 'task') &&
    ['failed', 'timed_out', 'detached', 'transport_lost', 'stale', 'blocked'].includes(
      String(value.failureKind)
    ) &&
    typeof value.acceptance === 'string' &&
    value.acceptance.length > 0 &&
    value.acceptance.length <= 220 &&
    !containsPrivateWorkText(value.acceptance)
  )
}

function isChannelMigrationApply(value: unknown): boolean {
  return (
    isRecord(value) &&
    Object.keys(value).length === 1 &&
    typeof value.confirmationToken === 'string' &&
    CHANNEL_MIGRATION_TOKEN.test(value.confirmationToken)
  )
}

function isDevinHostStart(value: unknown): boolean {
  return (
    isRecord(value) &&
    Object.keys(value).length === 1 &&
    typeof value.workspaceHandle === 'string' &&
    DEVIN_HOST_HANDLE.test(value.workspaceHandle)
  )
}

function isDevinHostPrompt(value: unknown): boolean {
  if (
    !isRecord(value) ||
    typeof value.prompt !== 'string' ||
    value.prompt.length === 0 ||
    value.prompt.length > MAX_DEVIN_PROMPT_LENGTH ||
    Object.keys(value).some((key) => key !== 'prompt' && key !== 'model')
  ) {
    return false
  }
  return (
    value.model === undefined ||
    (typeof value.model === 'string' && DEVIN_HOST_MODEL.test(value.model))
  )
}

function isDevinHostPermission(value: unknown): boolean {
  return (
    isRecord(value) &&
    Object.keys(value).length === 2 &&
    typeof value.permissionId === 'string' &&
    DEVIN_HOST_HANDLE.test(value.permissionId) &&
    (value.decision === 'allow_once' || value.decision === 'reject')
  )
}

export function validateDesktopIpcPayload(channel: ElectronIpcChannel, payload: unknown): boolean {
  switch (channel) {
    case 'dao:runtime-status':
    case 'dao:runtime-retry':
    case 'dao:dashboard-snapshot':
    case 'dao:open-config':
    case 'dao:control-open':
    case 'dao:taskboard-snapshot':
    case 'dao:taskboard-connect':
    case 'dao:channel-migration-preview':
    case 'dao:devin-host-status':
    case 'dao:devin-host-choose-workspace':
    case 'dao:devin-host-cancel':
    case 'dao:devin-host-stop':
      return payload === undefined
    case 'dao:control-request':
      return isAllowedDaoControlRequest(payload)
    case 'dao:work-attention-resolved':
      return isWorkFingerprintList(payload)
    case 'dao:work-attention-resolve':
      return isWorkResolution(payload)
    case 'dao:taskboard-create':
      return isTaskboardCreate(payload)
    case 'dao:channel-migration-apply':
      return isChannelMigrationApply(payload)
    case 'dao:devin-native-open':
    case 'dao:devin-host-start':
      return isDevinHostStart(payload)
    case 'dao:devin-host-prompt':
      return isDevinHostPrompt(payload)
    case 'dao:devin-host-permission':
      return isDevinHostPermission(payload)
    case 'dao:open-external':
      return (
        isRecord(payload) &&
        isHttpUrl(payload.url) &&
        Object.keys(payload).every((key) => key === 'url')
      )
    case 'dao:clipboard-write':
      return isTextPayload(payload)
    case 'dao:control-save-handoff':
      return isHandoffPayload(payload)
    default:
      return false
  }
}
