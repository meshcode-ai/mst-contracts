// CommonJS ts-node entry for the unmodified GMX Hardhat 2 toolchain.
// Offline demo driver. All oracle, position and liquidation logic comes from
// the pinned GMX implementation; this file only supplies test inputs/assertions.
import { expect } from '../upstream/gmx/node_modules/chai'
import hre from '../upstream/gmx/node_modules/hardhat'
import { time } from '../upstream/gmx/node_modules/@nomicfoundation/hardhat-network-helpers'
import { deployFixture } from '../upstream/gmx/utils/fixture'
import { handleDeposit } from '../upstream/gmx/utils/deposit'
import { handleOrder, OrderType } from '../upstream/gmx/utils/order'
import { executeLiquidation } from '../upstream/gmx/utils/liquidation'
import { executeWithOracleParams } from '../upstream/gmx/utils/exchange'
import { TOKEN_ORACLE_TYPES } from '../upstream/gmx/utils/oracle'
import { getAccountPositionCount } from '../upstream/gmx/utils/position'
import { expandDecimals, decimalToFloat } from '../upstream/gmx/utils/math'
import { grantRole } from '../upstream/gmx/utils/role'
import { errorsContract } from '../upstream/gmx/utils/error'
import * as keys from '../upstream/gmx/utils/keys'

const prices={normal:5000,'long-crash':4000,'short-squeeze':6000,stale:5000} as const
const selected=process.env.MST_DEMO_SCENARIO
if(selected&&!Object.hasOwn(prices,selected))throw new Error('Unsupported demo scenario')
describe('MST demo oracle on original GMX engine',()=>{
  for(const scenario of Object.keys(prices).filter(value=>!selected||value===selected) as (keyof typeof prices)[]){
    it(scenario,async()=>{
      expect(hre.network.name).eq('hardhat')
      expect((await hre.ethers.provider.getNetwork()).chainId).eq(31337)
      const fixture=await deployFixture()
      const {wallet,user0}=fixture.accounts
      const {roleStore,dataStore,ethUsdMarket,wnt,usdc,liquidationHandler}=fixture.contracts
      await handleDeposit(fixture,{create:{market:ethUsdMarket,longTokenAmount:expandDecimals(1000,18),shortTokenAmount:expandDecimals(5_000_000,6)}})
      const isLong=scenario!=='short-squeeze'
      await handleOrder(fixture,{create:{market:ethUsdMarket,initialCollateralToken:wnt,initialCollateralDeltaAmount:expandDecimals(10,18),sizeDeltaUsd:decimalToFloat(isLong?200_000:500_000),acceptablePrice:expandDecimals(isLong?5001:4999,12),orderType:OrderType.MarketIncrease,isLong},execute:{tokens:[wnt.address,usdc.address]}})
      await grantRole(roleStore,wallet.address,'LIQUIDATION_KEEPER')
      const before=await getAccountPositionCount(dataStore,user0.address)
      expect(before).eq(1)
      const minPrices=[expandDecimals(prices[scenario],4),expandDecimals(1,6)]
      const options={account:user0.address,market:ethUsdMarket,collateralToken:wnt,isLong,minPrices,maxPrices:minPrices}
      let liquidated=false,duplicateRejected=false,rejection=''
      if(scenario==='normal'){
        await expect(executeLiquidation(fixture,options)).to.be.revertedWithCustomError(errorsContract,'PositionShouldNotBeLiquidated')
        rejection='PositionShouldNotBeLiquidated'
      }else if(scenario==='stale'){
        const block=await hre.ethers.provider.getBlock('latest')
        const maxAge=await dataStore.getUint(keys.MAX_ORACLE_PRICE_AGE)
        await time.increase(Math.max(3601,maxAge.toNumber()+1))
        await expect(executeWithOracleParams(fixture,{oracleBlockNumber:block.number,tokens:[wnt.address,usdc.address],tokenOracleTypes:[TOKEN_ORACLE_TYPES.DEFAULT,TOKEN_ORACLE_TYPES.DEFAULT],precisions:[8,18],minPrices,maxPrices:minPrices,oracleTimestamps:[block.timestamp,block.timestamp],dataStreamTokens:[],dataStreamData:[],priceFeedTokens:[],execute:async(_key,oracleParams)=>liquidationHandler.executeLiquidation(user0.address,ethUsdMarket.marketToken,wnt.address,isLong,oracleParams)})).to.be.revertedWithCustomError(errorsContract,'MaxPriceAgeExceeded')
        rejection='MaxPriceAgeExceeded'
      }else{
        await executeLiquidation(fixture,options)
        liquidated=true
        await expect(executeLiquidation(fixture,options)).to.be.revertedWithCustomError(errorsContract,'EmptyOrder')
        duplicateRejected=true
      }
      const after=await getAccountPositionCount(dataStore,user0.address)
      expect(after).eq(liquidated?0:1)
      console.log('MST_ENGINE_RESULT '+JSON.stringify({scenario,chainId:31337,entryPriceUsd:'5000',priceUsd:String(prices[scenario]),side:isLong?'long':'short',positionCountBefore:before.toString(),positionCountAfter:after.toString(),liquidated,duplicateRejected,rejection,sourceCommit:'ee721b7e2d1891312dde52964d774144208cd1a0'}))
    })
  }
})
