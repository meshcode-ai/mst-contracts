import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { createPublicClient, createWalletClient, http, parseEther, keccak256, toHex, type Address, type Abi, type Hex } from 'viem'
import { foundry } from 'viem/chains'
import mstArtifact from '../artifacts/MeshToken.json'
import petArtifact from '../artifacts/Meshling.json'

let node:ChildProcess,admin:Address,user:Address,buyer:Address,mst:Address,pet:Address
let client:ReturnType<typeof createPublicClient>,wallet:ReturnType<typeof createWalletClient>
const mstAbi=mstArtifact.abi as Abi,petAbi=petArtifact.abi as Abi
async function write(address:Address,abi:Abi,functionName:string,args:unknown[],account=admin){
  const simulated=await client.simulateContract({address,abi,functionName,args,account})
  const hash=await wallet.writeContract({...simulated.request,chain:foundry})
  const receipt=await client.waitForTransactionReceipt({hash})
  expect(receipt.status).toBe('success')
  return receipt
}
async function read(address:Address,abi:Abi,functionName:string,args:unknown[]=[]){return client.readContract({address,abi,functionName,args})}
beforeAll(async()=>{
  const probe=createServer();await new Promise<void>(resolve=>probe.listen(0,'127.0.0.1',resolve))
  const port=(probe.address() as {port:number}).port;await new Promise<void>(resolve=>probe.close(()=>resolve()))
  const executable=new URL('../node_modules/.bin/anvil',import.meta.url).pathname
  node=spawn(executable,['--port',String(port),'--chain-id','31337','--silent'],{stdio:'ignore'})
  const transport=http(`http://127.0.0.1:${port}`,{retryCount:0,timeout:1000})
  client=createPublicClient({chain:foundry,transport});wallet=createWalletClient({chain:foundry,transport})
  for(let i=0;i<80;i++){
    if(node.exitCode!==null)throw new Error('isolated Anvil exited')
    try{if(await client.getChainId()===31337)break}catch{}
    if(i===79)throw new Error('isolated Anvil did not start')
    await Bun.sleep(50)
  }
  ;[admin,user,buyer]=await wallet.getAddresses()
  async function deploy(artifact:typeof mstArtifact,args:unknown[]){
    const hash=await wallet.deployContract({account:admin,chain:foundry,abi:artifact.abi,bytecode:artifact.bytecode as Hex,args})
    const receipt=await client.waitForTransactionReceipt({hash});expect(receipt.status).toBe('success')
    if(!receipt.contractAddress)throw new Error('missing contract address');return receipt.contractAddress
  }
  mst=await deploy(mstArtifact,[admin]);pet=await deploy(petArtifact,[admin,'https://metadata.example/meshpet/'])
},20_000)
afterAll(()=>node?.kill('SIGTERM'))

describe('adopted original MST + Meshling contracts',()=>{
  test('MST role-gated mint and burn preserve exact balances and supply',async()=>{
    const role=keccak256(toHex('MINTER_ROLE'))
    expect(await read(mst,mstAbi,'hasRole',[role,admin])).toBe(true)
    await expect(client.simulateContract({account:user,address:mst,abi:mstAbi,functionName:'mintOnTopUp',args:[user,1n]})).rejects.toThrow()
    await write(mst,mstAbi,'mintOnTopUp',[user,parseEther('100')])
    await write(mst,mstAbi,'burnOnUsage',[user,parseEther('7'),42n])
    expect(await read(mst,mstAbi,'balanceOf',[user])).toBe(parseEther('93'))
    expect(await read(mst,mstAbi,'totalSupply')).toBe(parseEther('93'))
    await expect(client.simulateContract({account:admin,address:mst,abi:mstAbi,functionName:'burnOnUsage',args:[user,parseEther('94'),42n]})).rejects.toThrow()
    expect(await read(mst,mstAbi,'balanceOf',[user])).toBe(parseEther('93'))
  })
  test('only collection owner mints; enumeration, metadata and royalty are unchanged',async()=>{
    await expect(client.simulateContract({account:user,address:pet,abi:petAbi,functionName:'mintPet',args:[user,123n]})).rejects.toThrow()
    await write(pet,petAbi,'mintPet',[user,123n])
    expect((await read(pet,petAbi,'ownerOf',[1n]) as string).toLowerCase()).toBe(user.toLowerCase())
    expect(await read(pet,petAbi,'totalMinted')).toBe(1n)
    expect(await read(pet,petAbi,'tokenOfOwnerByIndex',[user,0n])).toBe(1n)
    expect(await read(pet,petAbi,'tokenURI',[1n])).toBe('https://metadata.example/meshpet/1')
    const royalty=await read(pet,petAbi,'royaltyInfo',[1n,parseEther('100')]) as [Address,bigint]
    expect(royalty[0].toLowerCase()).toBe(admin.toLowerCase());expect(royalty[1]).toBe(parseEther('5'))
  })
  test('current owner changes after transfer and previous owner loses transfer authority',async()=>{
    await write(pet,petAbi,'transferFrom',[user,buyer,1n],user)
    expect((await read(pet,petAbi,'ownerOf',[1n]) as string).toLowerCase()).toBe(buyer.toLowerCase())
    expect(await read(pet,petAbi,'balanceOf',[user])).toBe(0n)
    await expect(client.simulateContract({account:user,address:pet,abi:petAbi,functionName:'transferFrom',args:[buyer,user,1n]})).rejects.toThrow()
    expect(await read(pet,petAbi,'totalSupply')).toBe(1n)
  })
})
