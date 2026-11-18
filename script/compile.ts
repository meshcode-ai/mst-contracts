import solc from 'solc'
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
const require = createRequire(import.meta.url)
const names = ['src/MeshToken.sol', 'src/Meshling.sol']
const sources = Object.fromEntries(names.map(name => [name, { content: readFileSync(resolve(import.meta.dir, '..', name), 'utf8') }]))
const result = JSON.parse(solc.compile(JSON.stringify({ language:'Solidity', sources,
  settings:{ optimizer:{ enabled:true, runs:200 }, evmVersion:'cancun', outputSelection:{'*':{'*':['abi','evm.bytecode.object']}} } }), {
  import: (path: string) => ({ contents: readFileSync(require.resolve(path.replace(/^openzeppelin-contracts\//, '@openzeppelin/contracts/')), 'utf8') }),
}))
const errors = (result.errors ?? []).filter((item: {severity:string}) => item.severity === 'error')
if (errors.length) throw new Error(errors.map((item:{formattedMessage:string}) => item.formattedMessage).join('\n'))
const out = resolve(import.meta.dir, '../artifacts')
mkdirSync(out, {recursive:true})
for (const file of names) for (const [name, value] of Object.entries(result.contracts[file])) {
  const artifact = value as {abi:unknown;evm:{bytecode:{object:string}}}
  writeFileSync(`${out}/${name}.json`, JSON.stringify({contractName:name,sourceName:file,compiler:solc.version(),abi:artifact.abi,bytecode:`0x${artifact.evm.bytecode.object}`}, null, 2)+'\n')
}
console.log(`Compiled ${names.length} source files with ${solc.version()}`)
