import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dir, '..')
const forge = resolve(root, 'node_modules/.bin/forge')
const pins = {
  'v4-core': 'e50237c43811bd9b526eff40f26772152a42daba',
  'v4-periphery': 'a7af5b345b479b05fde9182d7e40913a73b3e18f',
  'universal-router': '64027f3372aa235734207c4e05667204f6f927e1',
}
function run(command: string, args: string[], cwd: string) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' })
  if (result.status !== 0) throw new Error(`${command} failed in ${cwd}`)
}
for (const [name, sha] of Object.entries(pins)) {
  const cwd = resolve(root, 'upstream', name)
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' })
  if (head.status !== 0 || head.stdout.trim() !== sha) throw new Error(`Unexpected ${name} source pin`)
  run('git', ['diff', '--quiet', 'HEAD', '--', 'src', 'contracts'], cwd)
}
// Original router tag dependencies only. No upstream package scripts or source edits.
const dependencies = { '@openzeppelin/contracts': '5.0.2', '@uniswap/v2-core': '1.0.1', '@uniswap/v3-core': '1.0.0' }
const directory = resolve(root, '.build/router-dependencies')
mkdirSync(directory, { recursive: true })
writeFileSync(resolve(directory, 'package.json'), JSON.stringify({ name: 'mst-router-build-dependencies', private: true, dependencies }, null, 2) + '\n')
const modules = resolve(directory, 'node_modules')
if (!Object.entries(dependencies).every(([name, version]) => {
  try { return JSON.parse(readFileSync(resolve(modules, name, 'package.json'), 'utf8')).version === version }
  catch { return false }
})) run('bun', ['install', '--ignore-scripts'], directory)
const router = resolve(root, 'upstream/universal-router')
const routerModules = resolve(router, 'node_modules')
if (!existsSync(routerModules)) symlinkSync(modules, routerModules, 'dir')
for (const [name, version] of Object.entries(dependencies)) {
  if (JSON.parse(readFileSync(resolve(routerModules, name, 'package.json'), 'utf8')).version !== version) throw new Error(`Router build requires ${name}@${version}`)
}
run(forge, ['build', 'src/PoolManager.sol', '--skip', 'test', '--skip', 'script'], resolve(root, 'upstream/v4-core'))
run(forge, ['build', 'src/PositionManager.sol', 'src/lens/StateView.sol', 'src/lens/V4Quoter.sol', 'src/PositionDescriptor.sol', '--skip', 'test', '--skip', 'script'], resolve(root, 'upstream/v4-periphery'))
run(forge, ['build', 'src/Permit2.sol', 'lib/solmate/src/tokens/WETH.sol', '--skip', 'test', '--skip', 'script'], resolve(root, 'upstream/v4-periphery/lib/permit2'))
run(forge, ['build', 'contracts/UniversalRouter.sol', '--skip', 'test', '--skip', 'script'], router)
console.log('Pinned original AMM contracts compiled. No Solidity source was modified.')
