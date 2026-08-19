export const DAO_VIEWS = [
  'work',
  'settings',
  'decisions',
  'overview',
  'hud',
  'devinConnect',
  'collaboration',
  'tasks',
  'providers',
  'routes',
  'revproxy',
  'tunnel',
  'bridges',
  'customModels',
  'codex',
  'observability',
  'operations',
  'connectors'
] as const

export type DaoViewId = (typeof DAO_VIEWS)[number]
export const DAO_PRIMARY_VIEWS = ['work', 'hud', 'collaboration', 'settings'] as const
export type DaoPrimaryViewId = (typeof DAO_PRIMARY_VIEWS)[number]
export type DaoViewGroupId = 'runtime' | 'config' | 'collaboration' | 'advanced'

export type DaoViewDefinition = {
  id: DaoViewId
  label: string
  description: string
  eyebrow: string
  group: DaoViewGroupId
}

export type DaoViewGroupDefinition = {
  id: DaoViewGroupId
  label: string
  views: DaoViewId[]
}

export const DAO_VIEW_DEFINITIONS: DaoViewDefinition[] = [
  {
    id: 'work',
    label: '当前工作',
    description: '正在进行、需要你处理和计划验收的 Agent 工作',
    eyebrow: '工作台',
    group: 'runtime'
  },
  {
    id: 'settings',
    label: '设置',
    description: '渠道、优先级、Agent 接入与高级连接',
    eyebrow: '控制桌',
    group: 'config'
  },
  {
    id: 'decisions',
    label: '路由观察',
    description: '最近请求实际走向、异常事项和可选发送前检查',
    eyebrow: '工作台',
    group: 'runtime'
  },
  {
    id: 'overview',
    label: '首页',
    description: '现在是否正常、下一步做什么',
    eyebrow: '工作台',
    group: 'runtime'
  },
  {
    id: 'hud',
    label: '流量观测',
    description: '请求走向、缓存、亲和、延迟与异常',
    eyebrow: '控制桌',
    group: 'runtime'
  },
  {
    id: 'devinConnect',
    label: 'Devin 接入',
    description: '打开 Devin 原生窗口，或显式使用 FOMO FLOW 托管 ACP',
    eyebrow: '协作与交接',
    group: 'collaboration'
  },
  {
    id: 'collaboration',
    label: 'ACP 协作',
    description: 'Agent、会话、任务、产物与人工交接',
    eyebrow: '控制桌',
    group: 'collaboration'
  },
  {
    id: 'tasks',
    label: '任务进度',
    description: '跨代理任务进度、尝试和交接',
    eyebrow: '协作与交接',
    group: 'collaboration'
  },
  {
    id: 'providers',
    label: '接入渠道',
    description: '添加渠道、检查可用性和模型',
    eyebrow: '路由配置',
    group: 'config'
  },
  {
    id: 'routes',
    label: '模型怎么走',
    description: '决定 Devin/Codex 请求走哪家',
    eyebrow: '路由配置',
    group: 'config'
  },
  {
    id: 'revproxy',
    label: '本地接口',
    description: '查看本机应用连接 FOMO FLOW 使用的接口地址',
    eyebrow: '高级连接',
    group: 'advanced'
  },
  {
    id: 'tunnel',
    label: '远程访问',
    description: '管理从其他设备访问本机服务的连接',
    eyebrow: '高级连接',
    group: 'advanced'
  },
  {
    id: 'bridges',
    label: '接口兼容',
    description: '让不同格式的模型接口能够互相转接',
    eyebrow: '高级连接',
    group: 'advanced'
  },
  {
    id: 'customModels',
    label: '自定义模型',
    description: '多渠道模型和手动故障转移',
    eyebrow: '路由配置',
    group: 'config'
  },
  {
    id: 'codex',
    label: 'Codex 连接',
    description: '选择 Codex 上游和思考强度',
    eyebrow: '协作与交接',
    group: 'collaboration'
  },
  {
    id: 'observability',
    label: '问题与数据',
    description: '先看结论，再展开原因和技术细节',
    eyebrow: '工作台',
    group: 'runtime'
  },
  {
    id: 'operations',
    label: '运行健康',
    description: '本机服务、观测源、渠道与任务板健康',
    eyebrow: '运维控制',
    group: 'runtime'
  },
  {
    id: 'connectors',
    label: '外部接入',
    description: '查看 Codex、IDE 和其他客户端如何接入',
    eyebrow: '高级连接',
    group: 'advanced'
  }
]

export const DAO_VIEW_GROUPS: DaoViewGroupDefinition[] = [
  {
    id: 'runtime',
    label: '工作台',
    views: ['work', 'decisions', 'overview', 'operations', 'hud', 'observability']
  },
  {
    id: 'config',
    label: '路由配置',
    views: ['settings', 'providers', 'routes', 'customModels']
  },
  {
    id: 'collaboration',
    label: '协作与交接',
    views: ['devinConnect', 'collaboration', 'tasks', 'codex']
  },
  {
    id: 'advanced',
    label: '高级连接',
    views: ['revproxy', 'tunnel', 'bridges', 'connectors']
  }
]

export function viewsForGroup(
  group: DaoViewGroupId,
  views = DAO_VIEW_DEFINITIONS
): DaoViewDefinition[] {
  const ids = DAO_VIEW_GROUPS.find((item) => item.id === group)?.views ?? []
  return ids
    .map((id) => views.find((view) => view.id === id))
    .filter((view): view is DaoViewDefinition => Boolean(view))
}

export const DAO_SHELL_CHILDREN: Record<DaoPrimaryViewId, DaoViewId[]> = {
  work: ['work'],
  hud: ['hud', 'overview', 'operations', 'decisions', 'observability'],
  collaboration: ['collaboration', 'devinConnect', 'tasks'],
  settings: [
    'settings',
    'providers',
    'routes',
    'customModels',
    'codex',
    'revproxy',
    'tunnel',
    'bridges',
    'connectors'
  ]
}

export function shellViewFor(view: DaoViewId): DaoPrimaryViewId {
  return DAO_PRIMARY_VIEWS.find((shell) => DAO_SHELL_CHILDREN[shell].includes(view)) ?? 'work'
}

export function primaryViewDefinitions(
  views: DaoViewDefinition[] = DAO_VIEW_DEFINITIONS
): DaoViewDefinition[] {
  return DAO_PRIMARY_VIEWS.map((id) => views.find((view) => view.id === id)).filter(
    (view): view is DaoViewDefinition => Boolean(view)
  )
}

export function isDaoViewId(value: string): value is DaoViewId {
  return (DAO_VIEWS as readonly string[]).includes(value)
}
