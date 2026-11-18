import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { encodeFunctionData,keccak256,parseAbi,stringToHex,zeroAddress,type Abi,type Address,type Hex,type PublicClient,type WalletClient } from 'viem'
import { encodeSqrtRatioX96 } from '@uniswap/v3-sdk'
import { poolKey,type AmmDeployment } from '../sdk/amm'

const locations={
  PoolManager:'upstream/v4-core/out/PoolManager.sol/PoolManager.json',
  Permit2:'upstream/v4-periphery/lib/permit2/out/Permit2.sol/Permit2.json',
  WETH:'upstream/v4-periphery/lib/permit2/out/WETH.sol/WETH.json',
  StateView:'upstream/v4-periphery/foundry-out/StateView.sol/StateView.json',
  V4Quoter:'upstream/v4-periphery/foundry-out/V4Quoter.sol/V4Quoter.json',
  PositionDescriptor:'upstream/v4-periphery/foundry-out/PositionDescriptor.sol/PositionDescriptor.json',
  PositionManager:'upstream/v4-periphery/foundry-out/PositionManager.sol/PositionManager.json',
  UniversalRouter:'upstream/universal-router/out/UniversalRouter.sol/UniversalRouter.json',
} as const
export function ammArtifact(name:keyof typeof locations){
  const raw=JSON.parse(readFileSync(resolve(import.meta.dir,'..',locations[name]),'utf8'))
  const code=typeof raw.bytecode==='string'?raw.bytecode:raw.bytecode.object
  if(!code||code.includes('__'))throw new Error(`Build the pinned original ${name} first`)
  return {abi:raw.abi as Abi,bytecode:(code.startsWith('0x')?code:`0x${code}`) as Hex}
}
export async function deployAmmContracts(client:PublicClient,wallet:WalletClient,owner:Address,mst:Address):Promise<AmmDeployment>{
  if(await client.getChainId()!==31337||wallet.chain?.id!==31337)throw new Error('Only local Anvil 31337 is supported by this fixture deployment')
  const mstCode=await client.getCode({address:mst})
  if(!mstCode||mstCode==='0x')throw new Error('Deploy the original MST token first')
  const start=(await client.getBlockNumber({cacheTime:0}))+1n
  async function deploy(name:keyof typeof locations,args:unknown[]=[]){
    const hash=await wallet.deployContract({account:owner,chain:wallet.chain,...ammArtifact(name),args})
    const receipt=await client.waitForTransactionReceipt({hash})
    if(receipt.status!=='success'||!receipt.contractAddress)throw new Error(`Failed to deploy ${name}`)
    return receipt.contractAddress
  }
  const weth=await deploy('WETH'),permit2=await deploy('Permit2'),poolManager=await deploy('PoolManager',[owner])
  const stateView=await deploy('StateView',[poolManager]),quoter=await deploy('V4Quoter',[poolManager])
  const descriptor=await deploy('PositionDescriptor',[poolManager,weth,stringToHex('ETH',{size:32})])
  const positionManager=await deploy('PositionManager',[poolManager,permit2,100000n,descriptor,weth])
  const router=await deploy('UniversalRouter',[{permit2,weth9:weth,v2Factory:zeroAddress,v3Factory:zeroAddress,pairInitCodeHash:`0x${'00'.repeat(32)}`,poolInitCodeHash:`0x${'00'.repeat(32)}`,v4PoolManager:poolManager,permissionsAdapterFactory:zeroAddress,v3NFTPositionManager:zeroAddress,v4PositionManager:positionManager,spokePool:zeroAddress}])
  const values={mst,weth,poolManager,stateView,quoter,positionManager,permit2,router}
  const ammCodeHashes=Object.fromEntries(await Promise.all(Object.entries(values).map(async([name,address])=>{
    const code=await client.getCode({address});if(!code||code==='0x')throw new Error(`Missing ${name} code`)
    return [name,keccak256(code)]
  }))) as AmmDeployment['ammCodeHashes']
  const cfg={chainId:31337,...values,ammFromBlock:start.toString(),ammCodeHashes}
  const key=poolKey(cfg),mstIsZero=key.currency0.toLowerCase()===mst.toLowerCase()
  // Arbitrary local fixture ratio: 1000 MST / 1 WETH; not a token valuation.
  const sqrt=encodeSqrtRatioX96(mstIsZero?1n.toString():1000n.toString(),mstIsZero?1000n.toString():1n.toString())
  const abi=parseAbi(['function initialize((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks),uint160 sqrtPriceX96) returns (int24)'])
  const data=encodeFunctionData({abi,functionName:'initialize',args:[key as {currency0:Address;currency1:Address;fee:number;tickSpacing:number;hooks:Address},BigInt(sqrt.toString())]})
  const receipt=await client.waitForTransactionReceipt({hash:await wallet.sendTransaction({account:owner,chain:wallet.chain,to:poolManager,data})})
  if(receipt.status!=='success')throw new Error('Pool initialization failed')
  return cfg
}
