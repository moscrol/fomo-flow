import { describe, expect, it } from 'vitest'

import { createDaoRuntimeFacade, resolveDaoRuntimeRoot } from './dao-runtime'

describe('Dao Desktop runtime facade', () => {
  it('resolves dev, packaged, and explicit runtime roots', () => {
    expect(
      resolveDaoRuntimeRoot({
        isPackaged: false,
        resourcesPath: '/ignored',
        hostDirectory: '/work/dao/desktop/electron-dist',
        environment: {}
      })
    ).toBe('/work/dao')
    expect(
      resolveDaoRuntimeRoot({
        isPackaged: true,
        resourcesPath: '/Applications/FOMO FLOW.app/Contents/Resources',
        hostDirectory: '/ignored',
        environment: {}
      })
    ).toBe('/Applications/FOMO FLOW.app/Contents/Resources/dao-runtime')
    expect(
      resolveDaoRuntimeRoot({
        isPackaged: false,
        resourcesPath: '/ignored',
        hostDirectory: '/work/dao/desktop/electron-dist',
        environment: { DAO_DESKTOP_RUNTIME_ROOT: '/tmp/dao-runtime' }
      })
    ).toBe('/tmp/dao-runtime')
  })

  it('constructs the existing runtime with a Desktop user-data path', () => {
    const received: Array<Record<string, unknown>> = []
    const runtime = createDaoRuntimeFacade({
      runtimeRoot: '/work/dao',
      userDataDir: '/tmp/FOMO FLOW',
      loadModule: () => ({
        DaoDesktopRuntime: class {
          constructor(options: Record<string, unknown>) {
            received.push(options)
          }
          start() {
            return Promise.resolve({}) as never
          }
          status() {
            return {} as never
          }
          stop() {
            return Promise.resolve()
          }
        }
      })
    })

    expect(runtime).toBeInstanceOf(Object)
    expect(received).toEqual([{ userDataDir: '/tmp/FOMO FLOW', runtimeRoot: '/work/dao' }])
  })
})
