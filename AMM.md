# MST / WETH AMM integration

The integration deploys original public contracts and builds calls with official Uniswap SDKs. No Solidity trading engine, router, Permit2, WETH or LP contract is authored here. GIWA deployment is pending; the tested environment is isolated Anvil 31337.

## Reproducible sources

| Component | Original snapshot | Local artifact |
|---|---|---|
| PoolManager | v4-core v4.0.0, `e50237c43811bd9b526eff40f26772152a42daba` | `upstream/v4-core/out/PoolManager.sol/PoolManager.json` |
| PositionManager / PositionDescriptor / StateView / V4Quoter | v4-periphery `a7af5b345b479b05fde9182d7e40913a73b3e18f` | `upstream/v4-periphery/foundry-out/` |
| Universal Router | Git tag 2.2.0, `64027f3372aa235734207c4e05667204f6f927e1` | `upstream/universal-router/out/UniversalRouter.sol/UniversalRouter.json` |
| Permit2 | `cc56ad0f3439c502c246fc5cfcc3db92bb8b7219` | `upstream/v4-periphery/lib/permit2/out/Permit2.sol/Permit2.json` |
| WETH | Original Solmate implementation bundled by that Permit2 tree | `upstream/v4-periphery/lib/permit2/out/WETH.sol/WETH.json` |

Public source forks: [core](https://github.com/meshcode-ai/mst-amm-v4-core), [periphery](https://github.com/meshcode-ai/mst-amm-v4-periphery), [Universal Router](https://github.com/meshcode-ai/mst-amm-universal-router). Recursive submodules retain their original public dependency URLs.

The Router Git tag's package.json says 2.1.0. Its actual Git tree pins periphery a7af5b3 and Permit2 cc56ad0. Its Foundry lock lists other revisions for periphery/forge-std, so Foundry emits revision warnings. We preserve the tagged Git tree without rewriting upstream lockfiles. The periphery snapshot is a dependency pin, not an independent stable release tag.

The periphery builds against its bundled core 59d3ecf; the deployed PoolManager remains the stable e50237c. The production source comparison showed the relevant pool operation structs moved to PoolOperation.sol, with matching external tuple layouts and unchanged state storage libraries. The integration tests exercise quotes, real swaps and LP mint/removal against the deployed stable PoolManager. This is a scoped compatibility check for a zero-hook pool, not a claim that every hook or upstream feature was validated.

SDK packages are exact versions in package.json and bun.lock: v4-sdk 2.4.7, universal-router-sdk 5.17.0, sdk-core 7.22.0 and v3-sdk 3.31.11. Their official npm gitHead is `8ae0425c57e1699b0ae48ebb3077a2f526ae3818`.

## Build and tests

Bun 1.4.0 and the pinned Foundry 1.7.1 packages are used. Initial compilation may download original solc 0.8.26 and 0.8.17.

```sh
git submodule update --init --recursive
bun install --frozen-lockfile
bun run build
bun run build:amm
bun run test:amm
```

The build checks the three main source HEADs and rejects source modifications. Router's original npm build dependencies are installed separately under ignored `.build/router-dependencies`: OpenZeppelin 5.0.2, v2-core 1.0.1 and v3-core 1.0.0. The legacy MST contracts retain OpenZeppelin 5.1.0. No upstream package scripts are run. No upstream production source is patched.

The tests start and stop a separate Anvil on a free loopback port. They never reset an application's running chain or use private keys or external RPC endpoints.

| Input | Expected assertion |
|---|---|
| 1 MST exact input | MST debit is exact; WETH credit is at least min-out; successful original Router receipt |
| 0.001 WETH reverse trade | WETH debit is exact; MST credit is at least min-out |
| Impossible min-out / expired deadline / funded wallet without approval | Original Router call reverts; trader balances unchanged |
| Insufficient MST balance | Adapter rejects before any approval; wallet nonce and balance unchanged |
| 100 MST / 0.1 WETH desired full-range LP | Original PositionManager NFT owned by caller; positive liquidity; actual spends within SDK maxima |
| Another wallet's LP | Ownership read and original removal call reject |
| 50% liquidity removal | Actual liquidity decreases by SDK-calculated amount; both actual credits meet minimums |
| Remaining 100% liquidity removal | Position NFT is burned; owned list is refreshed; seed liquidity remains |
| Exact 2.2 swap tuple | Official SDK calldata decodes to V4_SWAP with single-hop swap, SETTLE_ALL and TAKE_ALL |
| Old quote / changed deployment / unsafe uint128 or slippage | Rejected before submission |

The final AMM integration/input run passed 13 tests (50 assertions). Later execution logs are kept by the integrating application and must be reported independently from upstream core tests or browser wallet tests.

## Adapter scope

Import `@mst/contracts/amm` in a Bun/TypeScript workspace, or import `sdk/amm.ts` directly. It contains browser-safe code, ABI declarations, official SDK call builders, original Quoter reads, exact allowance steps, transaction simulation/receipt checks and LP reconstruction. Deployment scripts and Node filesystem code are separate from that export.

The first pool has fee 3000 (0.30%), tick spacing 60, zero hooks, 18-decimal MST/WETH, and full-range ticks -887220 to 887220. The fixture initial ratio, 1000 MST per WETH, is arbitrary test input and not an MST valuation.

Swaps use exact input, 30-second quotes, minimum received and a 120-second chain deadline. Calls explicitly use `URVersion.V2_2_0`; the SDK default uses an older single-hop tuple without minHopPriceX36. The pool has no hook, so that new field is zero. Original deprecated FROM_DELTAS LP actions are not used.

Token allowances follow ERC20 → Permit2 → Router/PositionManager, with required amounts and a 10-minute Permit2 expiration. Approving is separate from trading. Applications must refresh the quote/LP preview after approvals and ask the user to execute the displayed result. No unlimited approval or automatic swap follows an approval.

Deployments carry eight distinct contract addresses, a starting block and runtime bytecode hashes. Reads and writes verify chain and actual code. Position lists scan original Transfer events in bounded chunks and confirm current ownerOf/pool/range; token-ID lookup is available when older history exceeds the bounded scan. Read failures propagate and are never represented as zero balances.

## Local application fixture

First run the existing local NFT/token deployment if a fresh chain needs it, then add AMM:

```sh
# Run Anvil separately on 127.0.0.1:8547 with chain ID 31337.
bun run deploy:local
bun run deploy:amm:local
```

`deploy:local` creates a fresh token/NFT setup; do not rerun it against an application deployment you want to preserve. `deploy:amm:local` reuses the existing MST address, retains NFT addresses, funds a separate third Anvil account, initializes the original pool and seeds liquidity. Subsequent runs reuse the verified AMM manifest. A reset chain requires resetting its local manifests deliberately.

The ignored `deployments/amm-local.json` contains addresses, runtime hashes, pool ID, start block and seed LP ID. If a sibling web workspace exists, only its 31337 entry is extended; a standalone checkout requires no website. No landing sources, wallet fixture injection, application assets, credentials or GIWA deployment are included by this command.
