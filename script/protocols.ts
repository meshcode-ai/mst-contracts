import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Abi, Address, Hex, PublicClient, WalletClient } from 'viem'

type Artifact={abi:Abi;bytecode:Hex}
export function artifact(name:'MST'|'Meshling'|'Seaport'|'ConduitController'|'SeaDrop'|'MeshPet'):Artifact{
  const path={MST:'artifacts/MeshToken.json',Meshling:'artifacts/Meshling.json',
    Seaport:'upstream/seaport/optimized-out/Seaport.sol/Seaport.json',
    ConduitController:'upstream/seaport/optimized-out/ConduitController.sol/ConduitController.json',
    SeaDrop:'upstream/seadrop/out/SeaDrop.sol/SeaDrop.json',MeshPet:'upstream/seadrop/out/ERC721SeaDrop.sol/ERC721SeaDrop.json'}[name]
  const raw=JSON.parse(readFileSync(resolve(import.meta.dir,'..',path),'utf8'))
  const code=typeof raw.bytecode==='string'?raw.bytecode:raw.bytecode.object
  if(typeof code!=='string'||code.includes('__'))throw new Error(`Build pinned upstream ${name} first`)
  return {abi:raw.abi,bytecode:(code.startsWith('0x')?code:`0x${code}`) as Hex}
}
export async function deploy(client:PublicClient,wallet:WalletClient,account:Address,name:Parameters<typeof artifact>[0],args:unknown[]=[]){
  const hash=await wallet.deployContract({account,chain:wallet.chain,...artifact(name),args})
  const receipt=await client.waitForTransactionReceipt({hash})
  if(receipt.status!=='success'||!receipt.contractAddress)throw new Error(`Failed ${name} deployment`)
  return receipt.contractAddress
}
export async function configureDrop(client:PublicClient,wallet:WalletClient,admin:Address,pet:Address,drop:Address){
  const {abi}=artifact('MeshPet')
  const block=await client.getBlock()
  async function write(functionName:string,args:unknown[]){
    const request=await client.simulateContract({account:admin,address:pet,abi,functionName,args})
    const hash=await wallet.writeContract({...request.request,chain:wallet.chain})
    if((await client.waitForTransactionReceipt({hash})).status!=='success')throw new Error('Drop configuration failed')
  }
  await write('setMaxSupply',[100n])
  await write('updateCreatorPayoutAddress',[drop,admin])
  await write('updatePublicDrop',[drop,{mintPrice:10n**16n,startTime:Number(block.timestamp-60n),endTime:Number(block.timestamp+86400n),maxTotalMintableByWallet:2,feeBps:0,restrictFeeRecipients:false}])
}
