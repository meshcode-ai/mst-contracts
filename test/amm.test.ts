import { afterAll,beforeAll,describe,expect,test } from 'bun:test'
import { spawn,type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { createPublicClient,createWalletClient,http,parseEther,type Address } from 'viem'
import { foundry } from 'viem/chains'
import { deploy } from '../script/protocols'
import { deployAmmContracts } from '../script/amm-deployment'
import { approveMint,approveSwap,assertDeployment,executeSwap,getMarket,getPosition,listPositions,mintLiquidity,previewMint,previewRemove,quoteSwap,removeLiquidity,swapParameters,tokenAbi,wrapWeth,type AmmDeployment } from '../sdk/amm'

let node:ChildProcess,admin:Address,trader:Address,other:Address,cfg:AmmDeployment,positionId:bigint
let client:ReturnType<typeof createPublicClient>,wallet:ReturnType<typeof createWalletClient>
// Each wallet is constructed against the isolated transport; no keys or live RPC.
let rpcUrl=''
const signing=(owner:Address)=>createWalletClient({account:owner,chain:foundry,transport:http(rpcUrl)})
const balance=(token:Address,owner=trader)=>client.readContract({address:token,abi:tokenAbi,functionName:'balanceOf',args:[owner]})
async function mintMst(owner:Address,value:bigint){
  const request=await client.simulateContract({account:admin,address:cfg.mst,abi:tokenAbi,functionName:'mintOnTopUp',args:[owner,value]})
  await client.waitForTransactionReceipt({hash:await wallet.writeContract({...request.request,chain:foundry})})
}
beforeAll(async()=>{
  const probe=createServer();await new Promise<void>(resolve=>probe.listen(0,'127.0.0.1',resolve));const port=(probe.address() as {port:number}).port
  await new Promise<void>(resolve=>probe.close(()=>resolve()))
  node=spawn(new URL('../node_modules/.bin/anvil',import.meta.url).pathname,['--port',String(port),'--chain-id','31337','--hardfork','cancun','--silent'],{stdio:'ignore'})
  rpcUrl=`http://127.0.0.1:${port}`;const transport=http(rpcUrl,{retryCount:0,timeout:5000})
  client=createPublicClient({chain:foundry,transport,cacheTime:0});wallet=createWalletClient({chain:foundry,transport})
  for(let i=0;i<80;i++){try{await client.getChainId();break}catch{if(i===79)throw new Error('Anvil startup failed');await Bun.sleep(50)}}
  ;[admin,trader,other]=await wallet.getAddresses()
  const mst=await deploy(client,wallet,admin,'MST',[admin])
  cfg=await deployAmmContracts(client,wallet,admin,mst)
  await mintMst(admin,parseEther('100000'));await mintMst(trader,parseEther('1000'));await mintMst(other,parseEther('10'))
  await wrapWeth(client,signing(admin),cfg,parseEther('12'))
  await wrapWeth(client,signing(trader),cfg,parseEther('2'))
  const seed=await previewMint(client,cfg,admin,parseEther('10000'),parseEther('10'),50)
  await approveMint(client,signing(admin),cfg,seed);await mintLiquidity(client,signing(admin),cfg,seed)
},60_000)
afterAll(()=>node?.kill('SIGTERM'))

describe('original Uniswap v4 contracts on an isolated EVM',()=>{
  test('wrong chain and changed deployed bytecode keep the AMM gate closed',async()=>{
    await expect(getMarket(client,{...cfg,chainId:91342})).rejects.toThrow('네트워크가 일치')
    await expect(assertDeployment(client,{...cfg,ammCodeHashes:{...cfg.ammCodeHashes,router:`0x${'00'.repeat(32)}`}})).rejects.toThrow('배포 코드가 일치')
  })
  test('MST to WETH swaps through real Permit2 and Universal Router',async()=>{
    const input=parseEther('1'),beforeMst=await balance(cfg.mst),beforeWeth=await balance(cfg.weth)
    const quote=await quoteSwap(client,cfg,'MST',input,trader)
    await approveSwap(client,signing(trader),cfg,quote)
    const refreshed=await quoteSwap(client,cfg,'MST',input,trader),plan=swapParameters(cfg,refreshed,50)
    const receipt=await executeSwap(client,signing(trader),cfg,refreshed,50)
    expect(receipt.status).toBe('success');expect(beforeMst-await balance(cfg.mst)).toBe(input)
    expect(await balance(cfg.weth)-beforeWeth).toBeGreaterThanOrEqual(plan.minimumOut)
  },20_000)
  test('reverse WETH to MST swaps and bounds exact input',async()=>{
    const input=parseEther('0.001'),beforeMst=await balance(cfg.mst),beforeWeth=await balance(cfg.weth)
    const quote=await quoteSwap(client,cfg,'WETH',input,trader);await approveSwap(client,signing(trader),cfg,quote)
    const fresh=await quoteSwap(client,cfg,'WETH',input,trader),plan=swapParameters(cfg,fresh,50)
    await executeSwap(client,signing(trader),cfg,fresh,50)
    expect(beforeWeth-await balance(cfg.weth)).toBe(input)
    expect(await balance(cfg.mst)-beforeMst).toBeGreaterThanOrEqual(plan.minimumOut)
  },20_000)
  test('original router rejects impossible min-out, expired deadline and missing allowance',async()=>{
    const quote=await quoteSwap(client,cfg,'MST',parseEther('1'),trader)
    await approveSwap(client,signing(trader),cfg,quote)
    const fresh=await quoteSwap(client,cfg,'MST',quote.amountIn,trader),beforeMst=await balance(cfg.mst),beforeWeth=await balance(cfg.weth)
    const plan=swapParameters(cfg,{...fresh,amountOut:fresh.amountOut*2n},0)
    await expect(client.call({account:trader,to:cfg.router,data:plan.data})).rejects.toThrow()
    const expired=swapParameters(cfg,fresh,50,fresh.blockTimestamp-1n)
    await expect(client.call({account:trader,to:cfg.router,data:expired.data})).rejects.toThrow()
    const noApproval=swapParameters(cfg,{...fresh,owner:other},50)
    await expect(client.call({account:other,to:cfg.router,data:noApproval.data})).rejects.toThrow()
    expect(await balance(cfg.mst)).toBe(beforeMst);expect(await balance(cfg.weth)).toBe(beforeWeth)
  },20_000)
  test('insufficient balance is rejected before approvals or a transaction',async()=>{
    const quote=await quoteSwap(client,cfg,'MST',parseEther('100'),other)
    const nonce=await client.getTransactionCount({address:other}),before=await balance(cfg.mst,other)
    await expect(approveSwap(client,signing(other),cfg,quote)).rejects.toThrow('잔액이 부족')
    expect(await client.getTransactionCount({address:other})).toBe(nonce)
    expect(await balance(cfg.mst,other)).toBe(before)
  })
  test('LP mint creates a real position NFT within SDK spend caps',async()=>{
    const beforeMst=await balance(cfg.mst),beforeWeth=await balance(cfg.weth)
    const preview=await previewMint(client,cfg,trader,parseEther('100'),parseEther('0.1'),50)
    await approveMint(client,signing(trader),cfg,preview)
    const result=await mintLiquidity(client,signing(trader),cfg,preview);positionId=result.tokenId
    const position=await getPosition(client,cfg,trader,positionId)
    expect(position.liquidity).toBeGreaterThan(0n)
    expect(beforeMst-await balance(cfg.mst)).toBeLessThanOrEqual(preview.maximumMst)
    expect(beforeWeth-await balance(cfg.weth)).toBeLessThanOrEqual(preview.maximumWeth)
    expect((await listPositions(client,cfg,trader)).map(item=>item.tokenId)).toContain(positionId)
  },20_000)
  test('invalid removal percentages cannot produce a transaction',async()=>{
    for(const percentage of [0,-1,10001,1.5])await expect(previewRemove(client,cfg,trader,positionId,percentage,50)).rejects.toThrow('제거 비율')
  })
  test('another wallet cannot manage the position',async()=>{
    await expect(getPosition(client,cfg,other,positionId)).rejects.toThrow()
    const plan=await previewRemove(client,cfg,trader,positionId,5000,50)
    await expect(client.call({account:other,to:cfg.positionManager,data:plan.data})).rejects.toThrow()
  })
  test('partial LP removal changes actual liquidity and returns both assets',async()=>{
    const before=await getPosition(client,cfg,trader,positionId),beforeMst=await balance(cfg.mst),beforeWeth=await balance(cfg.weth)
    const plan=await previewRemove(client,cfg,trader,positionId,5000,50)
    await removeLiquidity(client,signing(trader),cfg,plan)
    const after=await getPosition(client,cfg,trader,positionId)
    expect(after.liquidity).toBe(before.liquidity-plan.liquidityRemoved)
    expect(await balance(cfg.mst)-beforeMst).toBeGreaterThanOrEqual(plan.minimumMst)
    expect(await balance(cfg.weth)-beforeWeth).toBeGreaterThanOrEqual(plan.minimumWeth)
  },20_000)
  test('full LP exit burns the actual NFT and refreshes the owned list',async()=>{
    const plan=await previewRemove(client,cfg,trader,positionId,10000,50)
    await removeLiquidity(client,signing(trader),cfg,plan)
    await expect(getPosition(client,cfg,trader,positionId)).rejects.toThrow()
    expect(await listPositions(client,cfg,trader)).toHaveLength(0)
    expect((await getMarket(client,cfg)).liquidity).toBeGreaterThan(0n)
  },20_000)
})
