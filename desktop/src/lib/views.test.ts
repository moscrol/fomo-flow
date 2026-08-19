import { describe, expect, it } from 'vitest'

import {
  DAO_PRIMARY_VIEWS,
  DAO_VIEWS,
  DAO_VIEW_DEFINITIONS,
  DAO_VIEW_GROUPS,
  primaryViewDefinitions,
  shellViewFor,
  viewsForGroup
} from './views'

describe('Dao view navigation groups', () => {
  it('keeps all legacy views and exposes exactly four primary shells', () => {
    expect(DAO_VIEWS).toHaveLength(18)
    expect(DAO_PRIMARY_VIEWS).toEqual(['work', 'hud', 'collaboration', 'settings'])
    expect(primaryViewDefinitions().map((view) => view.label)).toEqual([
      '当前工作',
      '流量观测',
      'ACP 协作',
      '设置'
    ])
  })

  it('maps every hidden child to one stable shell', () => {
    expect(shellViewFor('overview')).toBe('hud')
    expect(shellViewFor('decisions')).toBe('hud')
    expect(shellViewFor('observability')).toBe('hud')
    expect(shellViewFor('operations')).toBe('hud')
    expect(shellViewFor('devinConnect')).toBe('collaboration')
    expect(shellViewFor('tasks')).toBe('collaboration')
    expect(shellViewFor('routes')).toBe('settings')
    expect(shellViewFor('customModels')).toBe('settings')
    expect(shellViewFor('tunnel')).toBe('settings')
  })

  it('keeps the four navigation groups in the intended order', () => {
    expect(DAO_VIEW_GROUPS.map((group) => [group.id, group.label])).toEqual([
      ['runtime', '工作台'],
      ['config', '路由配置'],
      ['collaboration', '协作与交接'],
      ['advanced', '高级连接']
    ])
  })

  it('describes Current Work as a live desk without a completed-work bucket', () => {
    expect(DAO_VIEW_DEFINITIONS.find((view) => view.id === 'work')?.description).toBe(
      '正在进行、需要你处理和计划验收的 Agent 工作'
    )
  })

  it('describes route decisions as observation before optional checking', () => {
    expect(DAO_VIEW_DEFINITIONS.find((view) => view.id === 'decisions')).toMatchObject({
      label: '路由观察',
      description: '最近请求实际走向、异常事项和可选发送前检查'
    })
  })

  it('keeps every view in its intended group without losing members', () => {
    expect(DAO_VIEW_GROUPS.map((group) => [group.id, group.views])).toEqual([
      ['runtime', ['work', 'decisions', 'overview', 'operations', 'hud', 'observability']],
      ['config', ['settings', 'providers', 'routes', 'customModels']],
      ['collaboration', ['devinConnect', 'collaboration', 'tasks', 'codex']],
      ['advanced', ['revproxy', 'tunnel', 'bridges', 'connectors']]
    ])
  })

  it('makes every view ID uniquely reachable through one group', () => {
    const groupedIds = DAO_VIEW_GROUPS.flatMap((group) => group.views)

    expect(groupedIds).toHaveLength(DAO_VIEWS.length)
    expect(new Set(groupedIds).size).toBe(DAO_VIEWS.length)
    expect(new Set(groupedIds)).toEqual(new Set(DAO_VIEWS))
    expect(DAO_VIEW_DEFINITIONS.map((view) => view.id)).toHaveLength(DAO_VIEWS.length)
    expect(new Set(DAO_VIEW_DEFINITIONS.map((view) => view.id))).toEqual(new Set(DAO_VIEWS))

    for (const group of DAO_VIEW_GROUPS) {
      expect(viewsForGroup(group.id).map((view) => view.id)).toEqual(group.views)
    }
  })

  it('places the native-first Devin entry in collaboration without removing legacy views', () => {
    expect(DAO_VIEW_DEFINITIONS.find((view) => view.id === 'devinConnect')).toMatchObject({
      label: 'Devin 接入',
      description: '打开 Devin 原生窗口，或显式使用 FOMO FLOW 托管 ACP',
      group: 'collaboration'
    })
    expect(viewsForGroup('collaboration').map((view) => view.id)).toEqual([
      'devinConnect',
      'collaboration',
      'tasks',
      'codex'
    ])
  })
})
