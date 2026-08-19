import { useEffect, useRef, useState } from 'react'

import {
  desktopHost,
  type ChannelMigrationApplyResult,
  type ChannelMigrationPreview
} from '@/lib/desktopHost'
import { sanitizeDisplayText } from '@/components/work/displaySanitizer'

import { ControlStatus } from './ControlPrimitives'

type ChannelMigrationCardProps = {
  onMigrated(): Promise<void> | void
}

export function ChannelMigrationCard({ onMigrated }: ChannelMigrationCardProps) {
  const [preview, setPreview] = useState<ChannelMigrationPreview | null>(null)
  const [result, setResult] = useState<ChannelMigrationApplyResult | null>(null)
  const [checking, setChecking] = useState(false)
  const [applying, setApplying] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState('')
  const requestSeq = useRef(0)
  const cancelButtonRef = useRef<HTMLButtonElement>(null)

  useEffect(
    () => () => {
      requestSeq.current += 1
    },
    []
  )

  useEffect(() => {
    if (confirming) cancelButtonRef.current?.focus()
  }, [confirming])

  async function checkExistingConfig(): Promise<void> {
    const seq = ++requestSeq.current
    setChecking(true)
    setError('')
    setResult(null)
    try {
      const host = desktopHost()
      if (!host.previewChannelMigration) throw new Error('当前版本暂不支持迁移现有 FOMO FLOW 配置')
      const nextPreview = await host.previewChannelMigration()
      if (seq !== requestSeq.current) return
      setPreview(nextPreview)
    } catch (cause) {
      if (seq !== requestSeq.current) return
      setPreview(null)
      setError(
        sanitizeDisplayText(cause instanceof Error ? cause.message : cause, '现有 FOMO FLOW 配置检查失败')
      )
    } finally {
      if (seq === requestSeq.current) setChecking(false)
    }
  }

  async function applyMigration(): Promise<void> {
    const confirmationToken = preview?.confirmationToken
    if (!preview?.available || !confirmationToken || applying) return

    const seq = ++requestSeq.current
    setApplying(true)
    setError('')
    try {
      const host = desktopHost()
      if (!host.applyChannelMigration) throw new Error('当前版本暂不支持迁移现有 FOMO FLOW 配置')
      const nextResult = await host.applyChannelMigration(confirmationToken)
      if (seq !== requestSeq.current) return
      setResult(nextResult)
      setPreview(null)
      setConfirming(false)
      try {
        await onMigrated()
      } catch {
        if (seq === requestSeq.current) {
          setError('配置已导入，但页面刷新失败；请点击页面刷新。')
        }
      }
    } catch (cause) {
      if (seq !== requestSeq.current) return
      setError(
        sanitizeDisplayText(cause instanceof Error ? cause.message : cause, '现有 FOMO FLOW 配置导入失败')
      )
    } finally {
      if (seq === requestSeq.current) setApplying(false)
    }
  }

  return (
    <section
      className="data-panel channel-migration-card"
      aria-labelledby="channel-migration-title"
    >
      <div className="panel-heading">
        <div>
          <h3 id="channel-migration-title">迁移现有 FOMO FLOW 渠道</h3>
          <p>把原 Dao 的渠道、自定义模型与路由一次性搬进 Desktop。</p>
        </div>
        <span className="panel-note">手动预览 · 一次性导入</span>
      </div>

      <p className="empty-note channel-migration-boundary">
        不会探活、不会自动切换渠道，也不会优化或重排原 priority。
      </p>

      {preview && (
        <div className="channel-migration-preview">
          <div className="channel-migration-counts" aria-label="可迁移配置统计">
            <strong>{preview.providerCount} 个渠道</strong>
            <strong>{preview.customModelCount} 个自定义模型</strong>
            <strong>{preview.routeCount} 条路由</strong>
          </div>
          <p className="empty-note channel-migration-conflicts">
            新增 {preview.newProviderCount} · 覆盖 {preview.overwrittenProviderCount} · 保留 Desktop{' '}
            {preview.preservedDesktopProviderCount}
          </p>
          {preview.providerNames.length > 0 && (
            <div className="channel-migration-providers" aria-label="渠道名称预览">
              {preview.providerNames.map((name, index) => (
                <span key={`${name}-${index}`}>{name}</span>
              ))}
            </div>
          )}
          <p className="empty-note">{preview.message}</p>
          {preview.available && preview.confirmationToken && (
            <button
              className="control-action control-action-primary"
              type="button"
              disabled={checking || applying}
              onClick={() => setConfirming(true)}
            >
              导入渠道与路由
            </button>
          )}
        </div>
      )}

      <div className="control-actions-row">
        <button
          className="control-action control-action-secondary"
          type="button"
          disabled={checking || applying}
          onClick={() => void checkExistingConfig()}
        >
          {checking ? '正在检查…' : '检查现有 FOMO FLOW 配置'}
        </button>
      </div>
      {!confirming && (
        <ControlStatus message={error || result?.message || ''} error={Boolean(error)} />
      )}

      {confirming && preview?.available && preview.confirmationToken && (
        <div
          className="channel-migration-backdrop"
          role="presentation"
          onKeyDown={(event) => {
            if (event.key === 'Escape' && !applying) setConfirming(false)
          }}
        >
          <section
            className="channel-migration-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="channel-migration-confirm-title"
          >
            <header>
              <h3 id="channel-migration-confirm-title">确认导入现有 FOMO FLOW 配置</h3>
              <p>将导入现有 FOMO FLOW 的渠道、自定义模型和完整路由。</p>
            </header>
            <ul>
              <li>同名配置以现有 Dao 为准；Desktop 独有渠道保留。</li>
              <li>原路由 priority 顺序不会被优化或重排。</li>
              <li>确认前不会写配置；写入前会创建私有备份。</li>
            </ul>
            <ControlStatus message={error} error={Boolean(error)} />
            <div className="channel-migration-actions">
              <button
                ref={cancelButtonRef}
                className="control-action control-action-quiet"
                type="button"
                disabled={applying}
                onClick={() => setConfirming(false)}
              >
                取消
              </button>
              <button
                className="control-action control-action-primary"
                type="button"
                disabled={applying}
                onClick={() => void applyMigration()}
              >
                {applying ? '正在导入…' : '确认导入'}
              </button>
            </div>
          </section>
        </div>
      )}
    </section>
  )
}
