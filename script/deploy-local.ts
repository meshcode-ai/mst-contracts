import { createPublicClient,createWalletClient,http,parseEther,zeroAddress } from 'viem'
import { foundry } from 'viem/chains'
import { readFileSync,writeFileSync,mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { artifact,configureDrop,deploy } from './protocols'

// Fixed loopback target; this command accepts no private key or live RPC.
const transport=http('http://127.0.0.1:8547'),client=createPublicClient({chain:foundry,transport}),wallet=createWalletClient({chain:foundry,transport})
if(await client.getChainId()!==31337)throw new Error('Local Anvil chain 31337 is required')
const [admin,user]=await wallet.getAddresses()
if(!admin||!user)throw new Error('Anvil unlocked fixture accounts are required')
const mst=await deploy(client,wallet,admin,'MST',[admin])
const legacyPet=await deploy(client,wallet,admin,'Meshling',[admin,'https://metadata.example/meshpet/'])
const controller=await deploy(client,wallet,admin,'ConduitController')
const seaport=await deploy(client,wallet,admin,'Seaport',[controller])
const drop=await deploy(client,wallet,admin,'SeaDrop')
const pet=await deploy(client,wallet,admin,'MeshPet',['MeshPet','MESHPET',[drop]])
await configureDrop(client,wallet,admin,pet,drop)
for(const [address,value] of [[admin,parseEther('1000000')],[user,parseEther('1000')]] as const){
  const request=await client.simulateContract({account:admin,address:mst,abi:artifact('MST').abi,functionName:'mintOnTopUp',args:[address,value]})
  await client.waitForTransactionReceipt({hash:await wallet.writeContract(request.request)})
}
const request=await client.simulateContract({account:admin,address:drop,abi:artifact('SeaDrop').abi,functionName:'mintPublic',args:[pet,admin,zeroAddress,1n],value:parseEther('0.01')})
await client.waitForTransactionReceipt({hash:await wallet.writeContract(request.request)})
const result={chainId:31337,mst,pet,legacyPet,seaport,drop,feeRecipient:admin,blockNumber:(await client.getBlockNumber({cacheTime:0})).toString(),environment:'local-fixture',createdAt:new Date().toISOString()}
mkdirSync(resolve(import.meta.dir,'../deployments'),{recursive:true})
writeFileSync(resolve(import.meta.dir,'../deployments/local.json'),JSON.stringify(result,null,2)+'\n')
// Optional synchronization; the public contract repo also runs by itself.
for(const relative of ['../../apps/web/src/data/deployment.json','../../apps/meshpet/src-tauri/deployment.json']){
  const path=resolve(import.meta.dir,relative)
  try{const registry=JSON.parse(readFileSync(path,'utf8'));registry['31337']={chainId:31337,mst,pet,seaport,drop,feeRecipient:admin};writeFileSync(path,JSON.stringify(registry,null,2)+'\n')}catch(error){if(!(error&&typeof error==='object'&&'code'in error&&error.code==='ENOENT'))throw error}
}
console.log(JSON.stringify(result,null,2))
