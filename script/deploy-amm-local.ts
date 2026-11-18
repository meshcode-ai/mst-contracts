import { existsSync,mkdirSync,readFileSync,writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createPublicClient,createWalletClient,http,parseEther,type Address } from 'viem'
import { foundry } from 'viem/chains'
import { deployAmmContracts } from './amm-deployment'
import { approveMint,assertDeployment,getMarket,getPosition,mintLiquidity,poolId,previewMint,tokenAbi,wrapWeth,type AmmDeployment } from '../sdk/amm'

// Fixed loopback fixture only. No keys, live-chain deployment, or reset of NFT state.
const transport=http('http://127.0.0.1:8547',{retryCount:0})
const client=createPublicClient({chain:foundry,transport,cacheTime:0})
const wallet=createWalletClient({chain:foundry,transport})
if(await client.getChainId()!==31337)throw new Error('Only local Anvil 31337 is supported')
const [admin,nftBuyer,tester]=await wallet.getAddresses()
if(!admin||!nftBuyer||!tester)throw new Error('Three unlocked Anvil fixture accounts are required')
const file=resolve(import.meta.dir,'../deployments/amm-local.json')
const registryFile=resolve(import.meta.dir,'../../apps/web/src/data/deployment.json')
const old=JSON.parse(readFileSync(resolve(import.meta.dir,'../deployments/local.json'),'utf8'))
if(old.chainId!==31337)throw new Error('Original local MST deployment is required first')
const mst=old.mst as Address
const nftBalanceBefore=await client.readContract({address:mst,abi:tokenAbi,functionName:'balanceOf',args:[nftBuyer]})
let result:AmmDeployment&{poolId?:string;seedTokenId?:string;tester?:Address;environment?:string}
if(existsSync(file)){
  result=JSON.parse(readFileSync(file,'utf8'));await assertDeployment(client,result)
  console.log('Reusing the verified local AMM deployment')
}else{
  const cfg=await deployAmmContracts(client,wallet,admin,mst)
  const sign=(address:Address)=>createWalletClient({account:address,chain:foundry,transport})
  async function fundMst(address:Address,target:bigint){
    const current=await client.readContract({address:mst,abi:tokenAbi,functionName:'balanceOf',args:[address]})
    if(current>=target)return
    const simulation=await client.simulateContract({account:admin,address:mst,abi:tokenAbi,functionName:'mintOnTopUp',args:[address,target-current]})
    const receipt=await client.waitForTransactionReceipt({hash:await wallet.writeContract({...simulation.request,chain:foundry})})
    if(receipt.status!=='success')throw new Error('Fixture MST mint failed')
  }
  await fundMst(admin,parseEther('20000'));await fundMst(tester,parseEther('1000'))
  await wrapWeth(client,sign(admin),cfg,parseEther('12'))
  await wrapWeth(client,sign(tester),cfg,parseEther('2'))
  const preview=await previewMint(client,cfg,admin,parseEther('10000'),parseEther('10'),50)
  await approveMint(client,sign(admin),cfg,preview)
  const fresh=await previewMint(client,cfg,admin,parseEther('10000'),parseEther('10'),50)
  const seeded=await mintLiquidity(client,sign(admin),cfg,fresh)
  result={...cfg,poolId:poolId(cfg),seedTokenId:seeded.tokenId.toString(),tester,environment:'local-fixture'}
  mkdirSync(resolve(import.meta.dir,'../deployments'),{recursive:true})
  writeFileSync(file,JSON.stringify(result,null,2)+'\n')
}
if(result.seedTokenId)await getPosition(client,result,admin,BigInt(result.seedTokenId))
const market=await getMarket(client,result)
if(market.liquidity<=0n)throw new Error('The original pool has no seeded liquidity')
const nftBalanceAfter=await client.readContract({address:mst,abi:tokenAbi,functionName:'balanceOf',args:[nftBuyer]})
if(nftBalanceBefore!==nftBalanceAfter)throw new Error('Existing NFT buyer balance changed')
if(existsSync(registryFile)){
  const registry=JSON.parse(readFileSync(registryFile,'utf8'))
  if(registry['31337'].mst.toLowerCase()!==mst.toLowerCase())throw new Error('Web MST registry differs from the existing local deployment')
  const {chainId,mst:token,weth,poolManager,stateView,positionManager,permit2,router,quoter,ammFromBlock,ammCodeHashes}=result
  registry['31337']={...registry['31337'],chainId,mst:token,weth,poolManager,stateView,positionManager,permit2,router,quoter,ammFromBlock,ammCodeHashes}
  writeFileSync(registryFile,JSON.stringify(registry,null,2)+'\n')
}
console.log(JSON.stringify({...result,activeLiquidity:market.liquidity.toString(),existingNftBuyerBalanceUnchanged:true},null,2))
