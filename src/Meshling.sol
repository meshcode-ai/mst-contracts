// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC721} from "openzeppelin-contracts/token/ERC721/ERC721.sol";
import {ERC721Enumerable} from "openzeppelin-contracts/token/ERC721/extensions/ERC721Enumerable.sol";
import {ERC2981} from "openzeppelin-contracts/token/common/ERC2981.sol";
import {Ownable} from "openzeppelin-contracts/access/Ownable.sol";

/// @title MESHLING — crypto pet NFT
/// @notice The consumer hook of the MeshToken economy: a card-topped-up crypto pet.
/// @dev Each pet stores an on-chain gene seed (packed 8-gene visual dictionary, see game-design.md).
///  A 5% resale royalty (ERC-2981) is charged on secondary trades and routed to the treasury,
///  which feeds back into MST burn. Holding/reselling a pet retains or gains value because
///  meshcode keeps swapping in better open-weight models behind the same token.
contract Meshling is ERC721, ERC721Enumerable, ERC2981, Ownable {
    uint256 private _nextId = 1;
    string private _base;

    /// @notice Packed 8-gene visual seed per pet (species/color/pattern/... genetics).
    mapping(uint256 => uint256) public genes;

    event PetMinted(address indexed to, uint256 indexed tokenId, uint256 genes);

    constructor(address owner_, string memory baseURI_)
        ERC721("MESHLING", "MESHLING")
        Ownable(owner_)
    {
        _base = baseURI_;
        _setDefaultRoyalty(owner_, 500); // 5% secondary-sale royalty -> treasury -> MST burn
    }

    /// @notice Mint a pet with its genetic seed. Owner (meshcode backend) mints on hatch/purchase.
    function mintPet(address to, uint256 geneSeed) external onlyOwner returns (uint256 tokenId) {
        tokenId = _nextId++;
        genes[tokenId] = geneSeed;
        _safeMint(to, tokenId);
        emit PetMinted(to, tokenId, geneSeed);
    }

    /// @notice Total pets minted so far.
    function totalMinted() external view returns (uint256) {
        return _nextId - 1;
    }

    function setBaseURI(string calldata baseURI_) external onlyOwner {
        _base = baseURI_;
    }

    function setRoyalty(address receiver, uint96 feeNumerator) external onlyOwner {
        _setDefaultRoyalty(receiver, feeNumerator);
    }

    function _baseURI() internal view override returns (string memory) {
        return _base;
    }

    // ---- required multiple-inheritance overrides (OpenZeppelin v5) ----
    function _update(address to, uint256 tokenId, address auth)
        internal
        override(ERC721, ERC721Enumerable)
        returns (address)
    {
        return super._update(to, tokenId, auth);
    }

    function _increaseBalance(address account, uint128 value)
        internal
        override(ERC721, ERC721Enumerable)
    {
        super._increaseBalance(account, value);
    }

    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(ERC721, ERC721Enumerable, ERC2981)
        returns (bool)
    {
        return super.supportsInterface(interfaceId);
    }
}
