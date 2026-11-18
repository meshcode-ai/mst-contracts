import { afterAll,beforeAll,describe,expect,test } from 'bun:test'
import { spawn,type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { createRequire } from 'node:module'
import { createPublicClient,createWalletClient,http,parseEther,zeroAddress,type Address } from 'viem'
import { foundry } from 'viem/chains'
import { artifact,configureDrop,deploy } from '../script/protocols'
const require=createRequire(import.meta.url)
const {Seaport,ItemType}=require('@opensea/seaport-js')
const {JsonRpcProvider}=require('ethers')
let process:ChildProcess,admin:Address,seller:Address,buyer:Address,pet:Address,drop:Address,seaport:Address,mst:Address
let client:ReturnType<typeof createPublicClient>,wallet:ReturnType<typeof createWalletClient>
let provider:InstanceType<typeof JsonRpcProvider>,sellerSdk:InstanceType<typeof Seaport>,buyerSdk:InstanceType<typeof Seaport>
const petAbi=artifact('MeshPet').abi,dropAbi=artifact('SeaDrop').abi,mstAbi=artifact('MST').abi
async function write(address:Address,abi:typeof petAbi,functionName:string,args:unknown[],account=admin,value?:bigint){
  const request=await client.simulateContract({account,address,abi,functionName,args,value})
  const hash=await wallet.writeContract({...request.request,chain:foundry})
  expect((await client.waitForTransactionReceipt({hash})).status).toBe('success')
}
async function owner(id:bigint){return (await client.readContract({address:pet,abi:petAbi,functionName:'ownerOf',args:[id]}) as string).toLowerCase()}
async function balance(address:Address){return client.readContract({address:mst,abi:mstAbi,functionName:'balanceOf',args:[address]})}
async function listing(id:bigint){
  const useCase=await sellerSdk.createOrder({offer:[{itemType:ItemType.ERC721,token:pet,identifier:id.toString()}],
    consideration:[{itemType:ItemType.ERC20,token:mst,amount:parseEther('10').toString(),recipient:seller}],
    endTime:Math.floor(Date.now()/1000+3600).toString()},seller)
  return useCase.executeAllActions()
}
beforeAll(async()=>{
  const probe=createServer();await new Promise<void>(resolve=>probe.listen(0,'127.0.0.1',resolve));const port=(probe.address() as {port:number}).port
  await new Promise<void>(resolve=>probe.close(()=>resolve()))
  process=spawn(new URL('../node_modules/.bin/anvil',import.meta.url).pathname,['--port',String(port),'--chain-id','31337','--silent'],{stdio:'ignore'})
  const url=`http://127.0.0.1:${port}`,transport=http(url,{retryCount:0,timeout:1000})
  client=createPublicClient({chain:foundry,transport});wallet=createWalletClient({chain:foundry,transport})
  for(let i=0;i<80;i++){try{await client.getChainId();break}catch{if(i===79)throw new Error('Anvil startup failed');await Bun.sleep(50)}}
  ;[admin,seller,buyer]=await wallet.getAddresses()
  mst=await deploy(client,wallet,admin,'MST',[admin])
  const controller=await deploy(client,wallet,admin,'ConduitController')
  seaport=await deploy(client,wallet,admin,'Seaport',[controller])
  drop=await deploy(client,wallet,admin,'SeaDrop')
  pet=await deploy(client,wallet,admin,'MeshPet',['MeshPet','MESHPET',[drop]])
  await configureDrop(client,wallet,admin,pet,drop)
  await write(mst,mstAbi,'mintOnTopUp',[buyer,parseEther('100')])
  provider=new JsonRpcProvider(url)
  sellerSdk=new Seaport(await provider.getSigner(seller),{overrides:{contractAddress:seaport,seaportVersion:'1.6'}})
  buyerSdk=new Seaport(await provider.getSigner(buyer),{overrides:{contractAddress:seaport,seaportVersion:'1.6'}})
},20_000)
afterAll(()=>{provider?.destroy();process?.kill('SIGTERM')})
describe('pinned SeaDrop and Seaport contracts on isolated EVM',()=>{
  test('native ETH public mint transfers price once and creates the actual NFT',async()=>{
    const before=await client.getBalance({address:admin})
    await write(drop,dropAbi,'mintPublic',[pet,admin,zeroAddress,1n],seller,parseEther('0.01'))
    expect(await owner(1n)).toBe(seller.toLowerCase())
    expect(await client.getBalance({address:admin})-before).toBe(parseEther('0.01'))
    expect(await client.readContract({address:pet,abi:petAbi,functionName:'totalSupply'})).toBe(1n)
  })
  test('wrong payment and wallet cap revert without another NFT',async()=>{
    await expect(client.simulateContract({account:seller,address:drop,abi:dropAbi,functionName:'mintPublic',args:[pet,admin,zeroAddress,1n],value:1n})).rejects.toThrow()
    await expect(client.simulateContract({account:seller,address:drop,abi:dropAbi,functionName:'mintPublic',args:[pet,admin,zeroAddress,2n],value:parseEther('0.02')})).rejects.toThrow()
    expect(await client.readContract({address:pet,abi:petAbi,functionName:'totalSupply'})).toBe(1n)
  })
  test('MST fixed-price order settles exactly once through Seaport',async()=>{
    const order=await listing(1n)
    const useCase=await buyerSdk.fulfillOrder({order,accountAddress:buyer})
    await (await useCase.executeAllActions()).wait()
    expect(await owner(1n)).toBe(buyer.toLowerCase())
    expect(await balance(buyer)).toBe(parseEther('90'));expect(await balance(seller)).toBe(parseEther('10'))
    await expect((async()=>{const retry=await buyerSdk.fulfillOrder({order,accountAddress:buyer});await (await retry.executeAllActions()).wait()})()).rejects.toThrow()
    expect(await balance(buyer)).toBe(parseEther('90'))
  })
  test('onchain cancellation blocks a shared order from executing',async()=>{
    await write(drop,dropAbi,'mintPublic',[pet,admin,zeroAddress,1n],seller,parseEther('0.01'))
    const order=await listing(2n)
    const transaction=await sellerSdk.cancelOrders([order.parameters],seller).transact();await transaction.wait()
    await expect((async()=>{const useCase=await buyerSdk.fulfillOrder({order,accountAddress:buyer});await (await useCase.executeAllActions()).wait()})()).rejects.toThrow()
    expect(await owner(2n)).toBe(seller.toLowerCase());expect(await balance(buyer)).toBe(parseEther('90'))
  })
})
