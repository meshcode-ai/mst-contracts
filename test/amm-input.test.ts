import { expect, test } from 'bun:test'
import { decodeAbiParameters, decodeFunctionData, parseAbiParameters, type Address } from 'viem'
import { configKey, minimumOut, swapParameters, routerAbi, type AmmDeployment, type SwapQuote } from '../sdk/amm'

const names = ['mst','weth','poolManager','quoter','stateView','positionManager','permit2','router'] as const
const addresses = Object.fromEntries(names.map((name,index)=>[name,`0x${(index+1).toString(16).padStart(40,'0')}`]))
const cfg = { chainId:31337,...addresses,ammFromBlock:'0',ammCodeHashes:Object.fromEntries(names.map(name=>[name,`0x${'ab'.repeat(32)}`])) } as AmmDeployment
const owner = '0x0000000000000000000000000000000000000020' as Address
function quote():SwapQuote {return { configKey:configKey(cfg),owner,input:'MST',amountIn:1000n,amountOut:995n,quotedAt:Date.now(),blockNumber:1n,blockTimestamp:BigInt(Math.floor(Date.now()/1000)) }}

test('min-out uses integer units and rejects unsafe inputs',()=>{
  expect(minimumOut(995n,50)).toBe(990n)
  for(const bps of [-1,501,1.5,NaN])expect(()=>minimumOut(995n,bps)).toThrow()
  expect(()=>minimumOut(1n,50)).toThrow()
})
test('official SDK encodes the adopted 2.2 single-hop swap layout',()=>{
  const current=quote(),plan=swapParameters(cfg,current,50)
  const call=decodeFunctionData({abi:routerAbi,data:plan.data})
  expect(call.functionName).toBe('execute')
  const [commands,inputs,deadline]=call.args!
  expect(commands).toBe('0x10');expect(deadline).toBe(current.blockTimestamp+120n)
  const [actions,parameters]=decodeAbiParameters(parseAbiParameters('bytes,bytes[]'),inputs[0])
  expect(actions).toBe('0x060c0f')
  const [swap]=decodeAbiParameters(parseAbiParameters('((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 amountIn,uint128 amountOutMinimum,uint256 minHopPriceX36,bytes hookData)'),parameters[0])
  expect(swap.amountIn).toBe(1000n);expect(swap.amountOutMinimum).toBe(990n)
  expect(swap.minHopPriceX36).toBe(0n);expect(swap.hookData).toBe('0x')
  expect(swap.poolKey.fee).toBe(3000);expect(swap.poolKey.tickSpacing).toBe(60)
})
test('old quotes and changed deployment cannot authorize a swap',()=>{
  const current=quote()
  expect(()=>swapParameters(cfg,{...current,quotedAt:Date.now()-31_000},50)).toThrow()
  expect(()=>swapParameters({...cfg,router:owner},current,50)).toThrow()
  expect(()=>swapParameters(cfg,{...current,amountIn:2n**128n},50)).toThrow()
})
