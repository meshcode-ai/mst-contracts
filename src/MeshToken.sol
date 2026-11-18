// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "openzeppelin-contracts/token/ERC20/ERC20.sol";
import {ERC20Burnable} from "openzeppelin-contracts/token/ERC20/extensions/ERC20Burnable.sol";
import {AccessControl} from "openzeppelin-contracts/access/AccessControl.sol";

/// @title MeshToken (MST)
/// @notice Elastic-supply utility token for the meshcode AI coding ADE.
/// @dev Economic model (see MESHLING x MeshToken deck):
///  - CHARGE: minted on fiat top-up (card -> MST) by MINTER_ROLE. No fixed cap; supply is elastic.
///  - USAGE : burned in proportion to the GPU compute spent when the AI is used (usage == burn),
///            so circulating supply deflates as the product is actually used.
///  Value is pegged to the #1 open-weight model, which keeps improving -> the same MST buys
///  ever-stronger AI over time.
contract MeshToken is ERC20, ERC20Burnable, AccessControl {
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");
    bytes32 public constant BURNER_ROLE = keccak256("BURNER_ROLE");

    /// @notice Emitted when MST is minted because a user topped up with fiat.
    event MintedOnTopUp(address indexed to, uint256 amount);
    /// @notice Emitted when MST is burned to settle GPU compute a user spent on the AI.
    event BurnedOnUsage(address indexed from, uint256 amount, uint256 computeUnits);

    constructor(address admin) ERC20("MeshToken", "MST") {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(MINTER_ROLE, admin);
        _grantRole(BURNER_ROLE, admin);
    }

    /// @notice Mint MST when a user charges with fiat (card). Supply is elastic (mint-on-purchase).
    function mintOnTopUp(address to, uint256 amount) external onlyRole(MINTER_ROLE) {
        _mint(to, amount);
        emit MintedOnTopUp(to, amount);
    }

    /// @notice Burn MST equal to the GPU compute a user consumed on the AI.
    /// @param computeUnits off-chain metered compute the burn settles (for on-chain accounting).
    function burnOnUsage(address from, uint256 amount, uint256 computeUnits) external onlyRole(BURNER_ROLE) {
        _burn(from, amount);
        emit BurnedOnUsage(from, amount, computeUnits);
    }
}
