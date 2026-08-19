import { desktopHost, type DaoControlMethod, type DaoControlResponse } from '@/lib/desktopHost'

export type DaoApi = {
  request<T = unknown>(path: string, method?: DaoControlMethod, body?: unknown): Promise<T>
  raw<T = unknown>(
    path: string,
    method?: DaoControlMethod,
    body?: unknown
  ): Promise<DaoControlResponse & { data: T }>
}

function responseError(response: DaoControlResponse): Error {
  const data = response.data
  const message =
    data && typeof data === 'object' && 'error' in data
      ? String((data as { error?: unknown }).error)
      : typeof data === 'string'
        ? data
        : `控制面请求失败（${response.status}）`
  return new Error(message || `控制面请求失败（${response.status}）`)
}

function responseFailed(response: DaoControlResponse): boolean {
  if (!response.ok) return true
  const data = response.data
  return (
    !!data &&
    typeof data === 'object' &&
    !Array.isArray(data) &&
    (data as { ok?: unknown }).ok === false
  )
}

export function daoControlApi(): DaoApi {
  const host = desktopHost()
  async function raw<T = unknown>(
    path: string,
    method: DaoControlMethod = 'GET',
    body?: unknown
  ): Promise<DaoControlResponse & { data: T }> {
    const response = await host.requestControl(path, method, body)
    if (responseFailed(response)) throw responseError(response)
    return response as DaoControlResponse & { data: T }
  }
  return {
    raw,
    async request<T = unknown>(path: string, method: DaoControlMethod = 'GET', body?: unknown) {
      return (await raw<T>(path, method, body)).data
    }
  }
}

export type JsonRecord = Record<string, unknown>

export function asRecord(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : {}
}

export function asArray<T = unknown>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : []
}
