import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export function resolveUserStateDir(home = homedir()): string {
  const dest = join(home, '.fomo-flow')
  const src = join(home, '.codeium', 'dao-byok')
  if (existsSync(dest)) return dest
  if (existsSync(src)) return src
  return dest
}

export function userStateFile(name: string, home = homedir()): string {
  return join(resolveUserStateDir(home), name)
}
