# Third-party sources

The original MST and Meshling source files retain their MIT SPDX notices. Build dependencies reproduce OpenZeppelin Contracts 5.1.0 for these legacy files.

Uniswap v4-core uses per-file BUSL-1.1 or MIT notices and license texts under `licenses/`. Preserve the exact pinned version and its terms. This workspace demonstrates local testing; publication is not a claim of a production usage grant.

Uniswap v4-periphery retains MIT headers on the selected PositionManager, PositionDescriptor, StateView and V4Quoter, along with its bundled dependency notices. Universal Router retains GPL-3.0-or-later on UniversalRouter.sol; its tagged package metadata separately declares GPL-2.0-or-later. Preserve original per-file and repository notices. Permit2 retains MIT; the bundled original Solmate WETH.sol retains AGPL-3.0-only. See the exact submodule trees and [AMM.md](AMM.md).

Official Uniswap SDK packages keep their own MIT notices and exact dependency lock entries. TypeScript integration does not relicense upstream Solidity or dependencies.

GMX Synthetics retains its original LICENSE and file headers. The pinned license specifies a change date of the earlier of 31 August 2026 or the stated ENS date and a GPL-2.0-or-later change license. Preserve the complete text and verify the scope of any deployed version.

Seaport and SeaDrop retain their MIT licenses and bundled dependency notices. Their submodules keep the original author attribution and licenses. Tests do not change upstream contract logic.

Application names and references identify upstream dependencies; no upstream endorsement is claimed.
