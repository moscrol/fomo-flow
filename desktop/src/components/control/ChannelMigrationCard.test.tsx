// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ChannelMigrationPreview, DesktopHost } from '@/lib/desktopHost'
import { ChannelMigrationCard } from './ChannelMigrationCard'

function installHost({
  previewChannelMigration,
  applyChannelMigration
}: {
  previewChannelMigration: NonNullable<DesktopHost['previewChannelMigration']>
  applyChannelMigration: NonNullable<DesktopHost['applyChannelMigration']>
}) {
  window.desktopHost = {
    getRuntimeStatus: async () => ({
      healthy: true,
      running: true,
      port: 8955,
      url: 'http://127.0.0.1:8955',
      profile: 'desktop',
      imported: { config: false, revproxy: false },
      error: null
    }),
    retryRuntime: async () => ({
      healthy: true,
      running: true,
      port: 8955,
      url: 'http://127.0.0.1:8955',
      profile: 'desktop',
      imported: { config: false, revproxy: false },
      error: null
    }),
    getDashboardSnapshot: async () =>
      ({}) as Awaited<ReturnType<DesktopHost['getDashboardSnapshot']>>,
    openExternal: async () => undefined,
    openConfig: async () => undefined,
    openControlConsole: async () => undefined,
    requestControl: async () => ({ ok: true, status: 200, data: {} }),
    saveHandoff: async () => ({ ok: true }),
    writeClipboard: async () => undefined,
    previewChannelMigration,
    applyChannelMigration
  }
}

const safePreview: ChannelMigrationPreview = {
  available: true,
  sourceLabel: '现有 FOMO FLOW 配置',
  providerNames: ['glm', 'mimo', '鸡米花'],
  providerCount: 25,
  customModelCount: 9,
  routeCount: 64,
  newProviderCount: 24,
  overwrittenProviderCount: 1,
  preservedDesktopProviderCount: 1,
  priorityPreserved: true,
  confirmationToken: '07'.repeat(32),
  message: '找到可迁移的现有 FOMO FLOW 渠道与路由。'
}

afterEach(() => {
  cleanup()
  delete window.desktopHost
})

describe('Dao channel migration card', () => {
  it('previews safely and writes only after explicit confirmation', async () => {
    const previewChannelMigration = vi.fn<NonNullable<DesktopHost['previewChannelMigration']>>(
      async () => safePreview
    )
    const applyChannelMigration = vi.fn<NonNullable<DesktopHost['applyChannelMigration']>>(
      async () => ({
        ok: true,
        providerCount: 25,
        customModelCount: 9,
        routeCount: 64,
        backupCreated: true,
        priorityPreserved: true,
        reloadReflected: true,
        message: '现有 FOMO FLOW 渠道与路由已安全导入。'
      })
    )
    const onMigrated = vi.fn(async () => undefined)
    installHost({ previewChannelMigration, applyChannelMigration })

    render(<ChannelMigrationCard onMigrated={onMigrated} />)
    expect(previewChannelMigration).not.toHaveBeenCalled()
    expect(applyChannelMigration).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: '检查现有 FOMO FLOW 配置' }))
    expect(await screen.findByText('25 个渠道')).toBeInTheDocument()
    expect(screen.getByText('9 个自定义模型')).toBeInTheDocument()
    expect(screen.getByText('64 条路由')).toBeInTheDocument()
    expect(screen.getByText('新增 24 · 覆盖 1 · 保留 Desktop 1')).toBeInTheDocument()
    expect(screen.getByText('glm')).toBeInTheDocument()
    expect(screen.getByText('鸡米花')).toBeInTheDocument()
    expect(document.body.textContent).not.toContain(safePreview.confirmationToken)

    fireEvent.click(screen.getByRole('button', { name: '导入渠道与路由' }))
    expect(screen.getByRole('dialog', { name: '确认导入现有 FOMO FLOW 配置' })).toBeInTheDocument()
    expect(screen.getByText('原路由 priority 顺序不会被优化或重排。')).toBeInTheDocument()
    expect(applyChannelMigration).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: '确认导入' }))
    await waitFor(() =>
      expect(applyChannelMigration).toHaveBeenCalledWith(safePreview.confirmationToken)
    )
    expect(applyChannelMigration).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(onMigrated).toHaveBeenCalledTimes(1))
    expect(await screen.findByText('现有 FOMO FLOW 渠道与路由已安全导入。')).toBeInTheDocument()
  })

  it('cancels without writing and keeps the preview available', async () => {
    const previewChannelMigration = vi.fn<NonNullable<DesktopHost['previewChannelMigration']>>(
      async () => safePreview
    )
    const applyChannelMigration = vi.fn<NonNullable<DesktopHost['applyChannelMigration']>>()
    installHost({ previewChannelMigration, applyChannelMigration })

    render(<ChannelMigrationCard onMigrated={() => undefined} />)
    fireEvent.click(screen.getByRole('button', { name: '检查现有 FOMO FLOW 配置' }))
    await screen.findByText('25 个渠道')
    fireEvent.click(screen.getByRole('button', { name: '导入渠道与路由' }))
    fireEvent.click(screen.getByRole('button', { name: '取消' }))

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByText('25 个渠道')).toBeInTheDocument()
    expect(applyChannelMigration).not.toHaveBeenCalled()
  })

  it('does not expose a write action when the source is unavailable', async () => {
    const previewChannelMigration = vi.fn<NonNullable<DesktopHost['previewChannelMigration']>>(
      async () => ({
        ...safePreview,
        available: false,
        providerNames: [],
        providerCount: 0,
        customModelCount: 0,
        routeCount: 0,
        confirmationToken: undefined,
        message: '没有找到可迁移的现有 FOMO FLOW 配置。'
      })
    )
    const applyChannelMigration = vi.fn<NonNullable<DesktopHost['applyChannelMigration']>>()
    installHost({ previewChannelMigration, applyChannelMigration })

    render(<ChannelMigrationCard onMigrated={() => undefined} />)
    fireEvent.click(screen.getByRole('button', { name: '检查现有 FOMO FLOW 配置' }))

    expect(await screen.findByText('没有找到可迁移的现有 FOMO FLOW 配置。')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '导入渠道与路由' })).not.toBeInTheDocument()
    expect(applyChannelMigration).not.toHaveBeenCalled()
  })

  it('prevents duplicate writes while an import is running', async () => {
    let resolveApply!: (
      value: Awaited<ReturnType<NonNullable<DesktopHost['applyChannelMigration']>>>
    ) => void
    const previewChannelMigration = vi.fn<NonNullable<DesktopHost['previewChannelMigration']>>(
      async () => safePreview
    )
    const applyChannelMigration = vi.fn<NonNullable<DesktopHost['applyChannelMigration']>>(
      () =>
        new Promise((resolve) => {
          resolveApply = resolve
        })
    )
    installHost({ previewChannelMigration, applyChannelMigration })

    render(<ChannelMigrationCard onMigrated={() => undefined} />)
    fireEvent.click(screen.getByRole('button', { name: '检查现有 FOMO FLOW 配置' }))
    await screen.findByText('25 个渠道')
    fireEvent.click(screen.getByRole('button', { name: '导入渠道与路由' }))
    const confirm = screen.getByRole('button', { name: '确认导入' })
    fireEvent.click(confirm)
    fireEvent.click(confirm)

    expect(applyChannelMigration).toHaveBeenCalledTimes(1)
    resolveApply({
      ok: true,
      providerCount: 25,
      customModelCount: 9,
      routeCount: 64,
      backupCreated: true,
      priorityPreserved: true,
      reloadReflected: true,
      message: '现有 FOMO FLOW 渠道与路由已安全导入。'
    })
    expect(await screen.findByText('现有 FOMO FLOW 渠道与路由已安全导入。')).toBeInTheDocument()
  })

  it('keeps a safe retryable preview when apply fails', async () => {
    const previewChannelMigration = vi.fn<NonNullable<DesktopHost['previewChannelMigration']>>(
      async () => safePreview
    )
    const applyChannelMigration = vi.fn<NonNullable<DesktopHost['applyChannelMigration']>>(
      async () => {
        throw new Error('写入失败 /Users/private/配置.json Authorization: Bearer secret')
      }
    )
    installHost({ previewChannelMigration, applyChannelMigration })

    render(<ChannelMigrationCard onMigrated={() => undefined} />)
    fireEvent.click(screen.getByRole('button', { name: '检查现有 FOMO FLOW 配置' }))
    await screen.findByText('25 个渠道')
    fireEvent.click(screen.getByRole('button', { name: '导入渠道与路由' }))
    fireEvent.click(screen.getByRole('button', { name: '确认导入' }))

    const dialog = screen.getByRole('dialog', { name: '确认导入现有 FOMO FLOW 配置' })
    expect(
      await within(dialog).findByText('写入失败 [路径已隐藏] Authorization: [凭据已隐藏]')
    ).toBeInTheDocument()
    expect(document.body.textContent).not.toContain('/Users/private')
    expect(document.body.textContent).not.toContain('Bearer secret')
    expect(screen.getByText('25 个渠道')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '确认导入' })).toBeEnabled()
  })

  it('does not misreport a completed migration when only the page refresh fails', async () => {
    const previewChannelMigration = vi.fn<NonNullable<DesktopHost['previewChannelMigration']>>(
      async () => safePreview
    )
    const applyChannelMigration = vi.fn<NonNullable<DesktopHost['applyChannelMigration']>>(
      async () => ({
        ok: true,
        providerCount: 25,
        customModelCount: 9,
        routeCount: 64,
        backupCreated: true,
        priorityPreserved: true,
        reloadReflected: true,
        message: '现有 FOMO FLOW 渠道与路由已安全导入。'
      })
    )
    const onMigrated = vi.fn(async () => {
      throw new Error('/Users/private/refresh-error')
    })
    installHost({ previewChannelMigration, applyChannelMigration })

    render(<ChannelMigrationCard onMigrated={onMigrated} />)
    fireEvent.click(screen.getByRole('button', { name: '检查现有 FOMO FLOW 配置' }))
    await screen.findByText('25 个渠道')
    fireEvent.click(screen.getByRole('button', { name: '导入渠道与路由' }))
    fireEvent.click(screen.getByRole('button', { name: '确认导入' }))

    expect(
      await screen.findByText('配置已导入，但页面刷新失败；请点击页面刷新。')
    ).toBeInTheDocument()
    expect(applyChannelMigration).toHaveBeenCalledTimes(1)
    expect(screen.queryByText('25 个渠道')).not.toBeInTheDocument()
    expect(document.body.textContent).not.toContain('/Users/private')
  })
})
