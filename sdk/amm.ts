import { Percent, Token } from '@uniswap/sdk-core'
import { Actions, Pool, Position, URVersion, V4Planner, V4PositionManager } from '@uniswap/v4-sdk'
import { CommandType, RoutePlanner } from '@uniswap/universal-router-sdk'
import { decodeEventLog, encodeFunctionData, getAddress, isAddress, keccak256, parseAbi, zeroAddress, type Address, type Hex, type PublicClient, type TransactionReceipt, type WalletClient } from 'viem'

export const addressFields = ['mst','weth','poolManager','quoter','stateView','positionManager','permit2','router'] as const
export type Asset = 'MST' | 'WETH'
export type AmmDeployment = { chainId:number; ammFromBlock:string; ammCodeHashes:Record<typeof addressFields[number],Hex> } & Record<typeof addressFields[number],Address>
export type Progress = (step:string,hash?:Hex)=>void
export const FEE = 3000, TICK_SPACING = 60, LOWER_TICK = -887220, UPPER_TICK = 887220
export const QUOTE_AGE_MS = 30_000
export const tokenAbi = parseAbi(['function balanceOf(address) view returns (uint256)','function allowance(address,address) view returns (uint256)','function approve(address,uint256) returns (bool)','function decimals() view returns (uint8)','function symbol() view returns (string)','function mintOnTopUp(address,uint256)','function deposit() payable','function withdraw(uint256)'])
export const routerAbi = parseAbi(['function execute(bytes commands,bytes[] inputs,uint256 deadline) payable'])
export const permitAbi = parseAbi(['function allowance(address owner,address token,address spender) view returns (uint160 amount,uint48 expiration,uint48 nonce)','function approve(address token,address spender,uint160 amount,uint48 expiration)'])
export const stateAbi = parseAbi(['function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96,int24 tick,uint24 protocolFee,uint24 lpFee)','function getLiquidity(bytes32 poolId) view returns (uint128)'])
export const quoterAbi = parseAbi(['function quoteExactInputSingle(((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 exactAmount,bytes hookData) params) returns (uint256 amountOut,uint256 gasEstimate)'])
export const positionAbi = parseAbi(['function ownerOf(uint256 tokenId) view returns (address)','function getPositionLiquidity(uint256 tokenId) view returns (uint128)','function getPoolAndPositionInfo(uint256 tokenId) view returns ((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,uint256 info)','event Transfer(address indexed from,address indexed to,uint256 indexed tokenId)'])

export function configKey(cfg:AmmDeployment){return [cfg.chainId,...addressFields.flatMap(key=>[cfg[key]?.toLowerCase(),cfg.ammCodeHashes?.[key]?.toLowerCase()]),cfg.ammFromBlock].join(':')}
const equal=(a:string,b:string)=>a.toLowerCase()===b.toLowerCase()
function quantity(value:bigint){if(value<=0n||value>=2n**128n)throw new Error('수량은 0보다 크고 uint128 범위 안이어야 합니다.');return value}
function tolerance(bps:number){if(!Number.isInteger(bps)||bps<0||bps>500)throw new Error('슬리피지는 0~5% 범위로 입력하세요.');return new Percent(bps,10_000)}
export function minimumOut(output:bigint,bps:number){tolerance(bps);const value=output*BigInt(10_000-bps)/10_000n;if(value<=0n)throw new Error('최소 수령량이 너무 작습니다.');return value}
function fresh(quotedAt:number){const age=Date.now()-quotedAt;if(!Number.isFinite(age)||age< -5000||age>QUOTE_AGE_MS)throw new Error('견적이 만료됐습니다. 다시 확인하세요.')}
export function tokens(cfg:AmmDeployment){return {MST:new Token(cfg.chainId,cfg.mst,18,'MST','MeshToken'),WETH:new Token(cfg.chainId,cfg.weth,18,'WETH','Wrapped Ether')}}
export function poolKey(cfg:AmmDeployment){const pair=tokens(cfg);return Pool.getPoolKey(pair.MST,pair.WETH,FEE,TICK_SPACING,zeroAddress)}
export function poolId(cfg:AmmDeployment){const pair=tokens(cfg);return Pool.getPoolId(pair.MST,pair.WETH,FEE,TICK_SPACING,zeroAddress) as Hex}
export function assetAddress(cfg:AmmDeployment,asset:Asset){return asset==='MST'?cfg.mst:cfg.weth}
export async function assertDeployment(client:PublicClient,cfg:AmmDeployment){
  if(![31337,91342].includes(cfg.chainId)||await client.getChainId()!==cfg.chainId)throw new Error('AMM RPC 네트워크가 일치하지 않습니다.')
  if(addressFields.some(key=>!cfg[key]||!isAddress(cfg[key])||equal(cfg[key],zeroAddress))||new Set(addressFields.map(key=>cfg[key].toLowerCase())).size!==addressFields.length)throw new Error('AMM 계약 구성을 확인하세요.')
  await Promise.all(addressFields.map(async key=>{
    const code=await client.getCode({address:cfg[key]})
    if(!code||code==='0x'||!cfg.ammCodeHashes?.[key]||!equal(keccak256(code),cfg.ammCodeHashes[key]))throw new Error(`${key}의 배포 코드가 일치하지 않습니다.`)
  }))
}
export type Market={pool:Pool;liquidity:bigint;sqrtPriceX96:bigint;tick:number;protocolFee:number;lpFee:number;blockNumber:bigint;blockTimestamp:bigint;quotedAt:number}
export async function getMarket(client:PublicClient,cfg:AmmDeployment):Promise<Market>{
  await assertDeployment(client,cfg)
  const blockNumber=await client.getBlockNumber({cacheTime:0}),id=poolId(cfg)
  const [slot,liquidity,block,mstDecimals,wethDecimals]=await Promise.all([
    client.readContract({address:cfg.stateView,abi:stateAbi,functionName:'getSlot0',args:[id],blockNumber}),
    client.readContract({address:cfg.stateView,abi:stateAbi,functionName:'getLiquidity',args:[id],blockNumber}),
    client.getBlock({blockNumber}),
    client.readContract({address:cfg.mst,abi:tokenAbi,functionName:'decimals',blockNumber}),
    client.readContract({address:cfg.weth,abi:tokenAbi,functionName:'decimals',blockNumber}),
  ])
  if(!slot[0]||Number(mstDecimals)!==18||Number(wethDecimals)!==18||slot[3]!==FEE)throw new Error('풀 초기화 또는 지원 토큰 단위를 확인하세요.')
  const pair=tokens(cfg),pool=new Pool(pair.MST,pair.WETH,FEE,TICK_SPACING,zeroAddress,slot[0].toString(),liquidity.toString(),slot[1])
  return {pool,liquidity,sqrtPriceX96:slot[0],tick:slot[1],protocolFee:slot[2],lpFee:slot[3],blockNumber,blockTimestamp:block.timestamp,quotedAt:Date.now()}
}
export type SwapQuote={configKey:string;owner:Address;input:Asset;amountIn:bigint;amountOut:bigint;quotedAt:number;blockNumber:bigint;blockTimestamp:bigint}
export async function quoteSwap(client:PublicClient,cfg:AmmDeployment,input:Asset,amountIn:bigint,owner:Address=zeroAddress):Promise<SwapQuote>{
  quantity(amountIn);const market=await getMarket(client,cfg)
  if(market.liquidity===0n)throw new Error('교환할 유동성이 없습니다.')
  const key=poolKey(cfg),zeroForOne=equal(key.currency0,assetAddress(cfg,input))
  const result=await client.simulateContract({account:owner,address:cfg.quoter,abi:quoterAbi,functionName:'quoteExactInputSingle',args:[{poolKey:key as {currency0:Address;currency1:Address;fee:number;tickSpacing:number;hooks:Address},zeroForOne,exactAmount:amountIn,hookData:'0x'}],blockNumber:market.blockNumber})
  quantity(result.result[0])
  return {configKey:configKey(cfg),owner,input,amountIn,amountOut:result.result[0],quotedAt:Date.now(),blockNumber:market.blockNumber,blockTimestamp:market.blockTimestamp}
}
export type CallPlan={to:Address;data:Hex;value:bigint;configKey:string;owner:Address;quotedAt:number;deadline:bigint}
export function swapParameters(cfg:AmmDeployment,quote:SwapQuote,bps:number,deadline=quote.blockTimestamp+120n){
  fresh(quote.quotedAt);quantity(quote.amountIn);quantity(quote.amountOut)
  if(quote.configKey!==configKey(cfg))throw new Error('AMM 배포가 변경됐습니다. 다시 견적을 확인하세요.')
  const minimum=minimumOut(quote.amountOut,bps),input=assetAddress(cfg,quote.input),output=assetAddress(cfg,quote.input==='MST'?'WETH':'MST'),key=poolKey(cfg)
  const v4=new V4Planner()
  v4.addAction(Actions.SWAP_EXACT_IN_SINGLE,[[key,equal(key.currency0,input),quote.amountIn.toString(),minimum.toString(),'0','0x']],URVersion.V2_2_0)
  v4.addAction(Actions.SETTLE_ALL,[input,quote.amountIn.toString()])
  v4.addAction(Actions.TAKE_ALL,[output,minimum.toString()])
  const router=new RoutePlanner();router.addCommand(CommandType.V4_SWAP,[v4.finalize()])
  return {to:cfg.router,data:encodeFunctionData({abi:routerAbi,functionName:'execute',args:[router.commands as Hex,router.inputs as Hex[],deadline]}),value:0n,configKey:quote.configKey,owner:quote.owner,quotedAt:quote.quotedAt,deadline,minimumOut:minimum}
}
function walletOwner(wallet:WalletClient,cfg:AmmDeployment){if(!wallet.account||wallet.chain?.id!==cfg.chainId)throw new Error('올바른 네트워크의 지갑을 연결하세요.');return getAddress(wallet.account.address)}
async function send(client:PublicClient,wallet:WalletClient,cfg:AmmDeployment,to:Address,data:Hex,value=0n,step='transaction',progress?:Progress){
  const owner=walletOwner(wallet,cfg);await assertDeployment(client,cfg)
  await client.call({account:owner,to,data,value})
  const estimate=await client.estimateGas({account:owner,to,data,value})
  progress?.(step)
  const hash=await wallet.sendTransaction({account:owner,chain:wallet.chain,to,data,value,gas:estimate*12n/10n})
  progress?.(step,hash)
  const receipt=await client.waitForTransactionReceipt({hash})
  if(receipt.status!=='success'||!equal(receipt.from,owner))throw new Error('거래가 확정되지 않았습니다. 거래 내역을 확인하세요.')
  return receipt
}
async function checkPlan(client:PublicClient,wallet:WalletClient,cfg:AmmDeployment,plan:CallPlan){
  fresh(plan.quotedAt)
  if(plan.configKey!==configKey(cfg)||!equal(plan.owner,walletOwner(wallet,cfg)))throw new Error('지갑 또는 배포가 변경됐습니다. 다시 견적을 확인하세요.')
  const block=await client.getBlock({blockTag:'latest'})
  if(block.timestamp>plan.deadline)throw new Error('거래 기한이 지났습니다. 다시 확인하세요.')
}
export async function needsApproval(client:PublicClient,cfg:AmmDeployment,owner:Address,spender:Address,spends:{token:Address;amount:bigint}[]){
  const now=(await client.getBlock({blockTag:'latest'})).timestamp
  const states=await Promise.all(spends.map(async spend=>{
    const [erc20,permit]=await Promise.all([
      client.readContract({address:spend.token,abi:tokenAbi,functionName:'allowance',args:[owner,cfg.permit2]}),
      client.readContract({address:cfg.permit2,abi:permitAbi,functionName:'allowance',args:[owner,spend.token,spender]}),
    ])
    return erc20<spend.amount||permit[0]<spend.amount||BigInt(permit[1])<=now+30n
  }))
  return states.some(Boolean)
}
async function approve(client:PublicClient,wallet:WalletClient,cfg:AmmDeployment,spender:Address,spends:{token:Address;amount:bigint}[],progress?:Progress){
  const owner=walletOwner(wallet,cfg);await assertDeployment(client,cfg)
  if(![cfg.router,cfg.positionManager].some(value=>equal(value,spender)))throw new Error('지원하지 않는 승인 대상입니다.')
  const receipts:TransactionReceipt[]=[]
  for(const {token,amount} of spends){
    quantity(amount)
    if(![cfg.mst,cfg.weth].some(value=>equal(value,token)))throw new Error('지원하지 않는 토큰입니다.')
    const [balance,allowance]=await Promise.all([
      client.readContract({address:token,abi:tokenAbi,functionName:'balanceOf',args:[owner]}),
      client.readContract({address:token,abi:tokenAbi,functionName:'allowance',args:[owner,cfg.permit2]}),
    ])
    if(balance<amount)throw new Error('최대 지출에 필요한 토큰 잔액이 부족합니다.')
    if(allowance<amount)receipts.push(await send(client,wallet,cfg,token,encodeFunctionData({abi:tokenAbi,functionName:'approve',args:[cfg.permit2,amount]}),0n,'approve-token',progress))
    const permit=await client.readContract({address:cfg.permit2,abi:permitAbi,functionName:'allowance',args:[owner,token,spender]})
    const now=(await client.getBlock({blockTag:'latest'})).timestamp
    if(permit[0]<amount||BigInt(permit[1])<=now+30n)receipts.push(await send(client,wallet,cfg,cfg.permit2,encodeFunctionData({abi:permitAbi,functionName:'approve',args:[token,spender,amount,Number(now+600n)]}),0n,'approve-spender',progress))
  }
  return receipts
}
export async function approveSwap(client:PublicClient,wallet:WalletClient,cfg:AmmDeployment,quote:SwapQuote,progress?:Progress){
  if(quote.configKey!==configKey(cfg)||!equal(quote.owner,walletOwner(wallet,cfg)))throw new Error('지갑 또는 배포가 변경됐습니다.')
  return approve(client,wallet,cfg,cfg.router,[{token:assetAddress(cfg,quote.input),amount:quote.amountIn}],progress)
}
export async function executeSwap(client:PublicClient,wallet:WalletClient,cfg:AmmDeployment,quote:SwapQuote,bps:number,progress?:Progress){
  const plan=swapParameters(cfg,quote,bps);await checkPlan(client,wallet,cfg,plan)
  if(await needsApproval(client,cfg,plan.owner,cfg.router,[{token:assetAddress(cfg,quote.input),amount:quote.amountIn}]))throw new Error('토큰 사용 승인을 먼저 완료하세요.')
  return send(client,wallet,cfg,plan.to,plan.data,0n,'swap',progress)
}
export type MintPreview=CallPlan&{position:Position;maximumMst:bigint;maximumWeth:bigint;amountMst:bigint;amountWeth:bigint}
function amounts(cfg:AmmDeployment,pool:Pool,amount0:bigint,amount1:bigint){return equal(pool.poolKey.currency0,cfg.mst)?{mst:amount0,weth:amount1}:{mst:amount1,weth:amount0}}
export async function previewMint(client:PublicClient,cfg:AmmDeployment,owner:Address,mst:bigint,weth:bigint,bps:number):Promise<MintPreview>{
  quantity(mst);quantity(weth);const market=await getMarket(client,cfg),slippage=tolerance(bps),mstFirst=equal(market.pool.poolKey.currency0,cfg.mst)
  const position=Position.fromAmounts({pool:market.pool,tickLower:LOWER_TICK,tickUpper:UPPER_TICK,amount0:(mstFirst?mst:weth).toString(),amount1:(mstFirst?weth:mst).toString(),useFullPrecision:true})
  if(BigInt(position.liquidity.toString())===0n)throw new Error('추가할 유동성이 너무 작습니다.')
  const maximum=position.mintAmountsWithSlippage(slippage),max=amounts(cfg,market.pool,BigInt(maximum.amount0.toString()),BigInt(maximum.amount1.toString()))
  quantity(max.mst);quantity(max.weth)
  const expected=amounts(cfg,market.pool,BigInt(position.mintAmounts.amount0.toString()),BigInt(position.mintAmounts.amount1.toString()))
  const deadline=market.blockTimestamp+120n,parameters=V4PositionManager.addCallParameters(position,{recipient:owner,slippageTolerance:slippage,deadline:deadline.toString(),hookData:'0x'})
  return {to:cfg.positionManager,data:parameters.calldata as Hex,value:BigInt(parameters.value),configKey:configKey(cfg),owner,quotedAt:Date.now(),deadline,position,maximumMst:max.mst,maximumWeth:max.weth,amountMst:expected.mst,amountWeth:expected.weth}
}
export async function approveMint(client:PublicClient,wallet:WalletClient,cfg:AmmDeployment,preview:MintPreview,progress?:Progress){
  if(preview.configKey!==configKey(cfg)||!equal(preview.owner,walletOwner(wallet,cfg)))throw new Error('지갑 또는 배포가 변경됐습니다.')
  return approve(client,wallet,cfg,cfg.positionManager,[{token:cfg.mst,amount:preview.maximumMst},{token:cfg.weth,amount:preview.maximumWeth}],progress)
}
export async function mintLiquidity(client:PublicClient,wallet:WalletClient,cfg:AmmDeployment,preview:MintPreview,progress?:Progress){
  await checkPlan(client,wallet,cfg,preview)
  if(await needsApproval(client,cfg,preview.owner,cfg.positionManager,[{token:cfg.mst,amount:preview.maximumMst},{token:cfg.weth,amount:preview.maximumWeth}]))throw new Error('두 토큰의 사용 승인을 먼저 완료하세요.')
  const receipt=await send(client,wallet,cfg,preview.to,preview.data,preview.value,'mint-liquidity',progress)
  for(const log of receipt.logs){
    if(!equal(log.address,cfg.positionManager))continue
    try{const event=decodeEventLog({abi:positionAbi,data:log.data,topics:log.topics});if(event.eventName==='Transfer'&&equal(event.args.from,zeroAddress)&&equal(event.args.to,preview.owner))return {receipt,tokenId:event.args.tokenId}}catch{}
  }
  throw new Error('민팅 거래의 LP 포지션 이벤트를 확인하세요.')
}
export type OwnedPosition={tokenId:bigint;owner:Address;liquidity:bigint;position:Position;amountMst:bigint;amountWeth:bigint}
class UnsupportedPosition extends Error{}
export async function getPosition(client:PublicClient,cfg:AmmDeployment,owner:Address,tokenId:bigint):Promise<OwnedPosition>{
  const actual=await client.readContract({address:cfg.positionManager,abi:positionAbi,functionName:'ownerOf',args:[tokenId]})
  if(!equal(actual,owner))throw new Error('이 지갑이 소유한 LP 포지션이 아닙니다.')
  const market=await getMarket(client,cfg)
  const [[key,info],liquidity]=await Promise.all([
    client.readContract({address:cfg.positionManager,abi:positionAbi,functionName:'getPoolAndPositionInfo',args:[tokenId]}),
    client.readContract({address:cfg.positionManager,abi:positionAbi,functionName:'getPositionLiquidity',args:[tokenId]}),
  ])
  const expected=poolKey(cfg)
  if(!equal(key.currency0,expected.currency0)||!equal(key.currency1,expected.currency1)||!equal(key.hooks,zeroAddress)||key.fee!==FEE||key.tickSpacing!==TICK_SPACING)throw new UnsupportedPosition('지원하는 MST/WETH 풀이 아닙니다.')
  // Original PositionInfoLibrary: signed int24 ticks at bit offsets 8 and 32.
  const tick=(shift:bigint)=>{const value=Number((info>>shift)&0xffffffn);return value>=0x800000?value-0x1000000:value}
  if(tick(8n)!==LOWER_TICK||tick(32n)!==UPPER_TICK)throw new UnsupportedPosition('현재는 전체 가격 범위 LP를 지원합니다.')
  const position=new Position({pool:market.pool,liquidity:liquidity.toString(),tickLower:LOWER_TICK,tickUpper:UPPER_TICK})
  const value=amounts(cfg,market.pool,BigInt(position.amount0.quotient.toString()),BigInt(position.amount1.quotient.toString()))
  return {tokenId,owner:getAddress(actual),liquidity,position,amountMst:value.mst,amountWeth:value.weth}
}
export async function listPositions(client:PublicClient,cfg:AmmDeployment,owner:Address){
  await assertDeployment(client,cfg)
  const end=await client.getBlockNumber({cacheTime:0}),start=BigInt(cfg.ammFromBlock)
  if(end<start||end-start>40_000n)throw new Error('LP 기록의 조회 범위를 확인하세요. 포지션 번호로 직접 조회할 수 있습니다.')
  const owners=new Map<string,Address>()
  for(let from=start;from<=end;from+=1000n){
    const to=from+999n<end?from+999n:end
    const events=await client.getContractEvents({address:cfg.positionManager,abi:positionAbi,eventName:'Transfer',fromBlock:from,toBlock:to,strict:true})
    for(const event of events)owners.set(event.args.tokenId.toString(),event.args.to)
  }
  const ids=[...owners].filter(([,value])=>equal(value,owner)).map(([id])=>BigInt(id))
  const positions:OwnedPosition[]=[]
  for(const id of ids){try{positions.push(await getPosition(client,cfg,owner,id))}catch(error){if(!(error instanceof UnsupportedPosition))throw error}}
  return positions
}
export type RemovePreview=CallPlan&{tokenId:bigint;liquidityBefore:bigint;liquidityRemoved:bigint;minimumMst:bigint;minimumWeth:bigint;amountMst:bigint;amountWeth:bigint}
export async function previewRemove(client:PublicClient,cfg:AmmDeployment,owner:Address,tokenId:bigint,percentage:number,bps:number):Promise<RemovePreview>{
  if(!Number.isInteger(percentage)||percentage<=0||percentage>10_000)throw new Error('제거 비율을 확인하세요.')
  const current=await getPosition(client,cfg,owner,tokenId),slippage=tolerance(bps),fraction=new Percent(percentage,10_000)
  const partial=new Position({pool:current.position.pool,liquidity:fraction.multiply(current.position.liquidity).quotient,tickLower:LOWER_TICK,tickUpper:UPPER_TICK})
  const liquidityRemoved=BigInt(partial.liquidity.toString());if(!liquidityRemoved)throw new Error('제거할 유동성이 너무 작습니다.')
  const min=partial.burnAmountsWithSlippage(slippage),minimum=amounts(cfg,partial.pool,BigInt(min.amount0.toString()),BigInt(min.amount1.toString()))
  const expected=amounts(cfg,partial.pool,BigInt(partial.amount0.quotient.toString()),BigInt(partial.amount1.quotient.toString()))
  const block=await client.getBlock({blockTag:'latest'}),deadline=block.timestamp+120n
  const parameters=V4PositionManager.removeCallParameters(current.position,{tokenId:tokenId.toString(),liquidityPercentage:fraction,slippageTolerance:slippage,deadline:deadline.toString(),burnToken:percentage===10_000,hookData:'0x'})
  return {to:cfg.positionManager,data:parameters.calldata as Hex,value:BigInt(parameters.value),configKey:configKey(cfg),owner,quotedAt:Date.now(),deadline,tokenId,liquidityBefore:current.liquidity,liquidityRemoved,minimumMst:minimum.mst,minimumWeth:minimum.weth,amountMst:expected.mst,amountWeth:expected.weth}
}
export async function removeLiquidity(client:PublicClient,wallet:WalletClient,cfg:AmmDeployment,preview:RemovePreview,progress?:Progress){
  await checkPlan(client,wallet,cfg,preview)
  const current=await getPosition(client,cfg,preview.owner,preview.tokenId)
  if(current.liquidity!==preview.liquidityBefore)throw new Error('포지션이 변경됐습니다. 제거 견적을 다시 확인하세요.')
  return send(client,wallet,cfg,preview.to,preview.data,preview.value,'remove-liquidity',progress)
}
export async function wrapWeth(client:PublicClient,wallet:WalletClient,cfg:AmmDeployment,value:bigint,progress?:Progress){
  quantity(value);return send(client,wallet,cfg,cfg.weth,encodeFunctionData({abi:tokenAbi,functionName:'deposit'}),value,'wrap',progress)
}
