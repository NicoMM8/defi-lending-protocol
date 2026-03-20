// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {ERC20Votes} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Votes.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Nonces} from "@openzeppelin/contracts/utils/Nonces.sol";

/**
 * @title GovernanceToken
 * @notice ERC-20 governance token with on-chain voting power (ERC20Votes).
 *         Token holders can create proposals, vote, and execute changes to the
 *         LendingPool through the ProtocolGovernor + Timelock mechanism.
 *
 * @dev Voting power is snapshot-based: checkpoints are written at each transfer
 *      so that proposals use the balance at the time of proposal creation —
 *      not at time of voting — preventing flash-loan governance attacks.
 *
 *      Holders MUST explicitly delegate to themselves (or another address)
 *      before their votes count. Call `delegate(address(this))`.
 */
contract GovernanceToken is ERC20, ERC20Permit, ERC20Votes, Ownable {

    /// @notice Maximum total supply: 100 million tokens.
    uint256 public constant MAX_SUPPLY = 100_000_000e18;

    /**
     * @param initialHolder Address receiving the initial token allocation.
     * @param initialSupply Amount of tokens to mint at deployment.
     */
    constructor(address initialHolder, uint256 initialSupply)
        ERC20("Protocol Governance Token", "PGT")
        ERC20Permit("Protocol Governance Token")
        Ownable(msg.sender)
    {
        require(initialSupply <= MAX_SUPPLY, "Exceeds max supply");
        _mint(initialHolder, initialSupply);
    }

    /**
     * @notice Mint additional tokens (up to MAX_SUPPLY). Owner only.
     * @param to     Recipient address.
     * @param amount Amount to mint (in 1e18 units).
     */
    function mint(address to, uint256 amount) external onlyOwner {
        require(totalSupply() + amount <= MAX_SUPPLY, "Exceeds max supply");
        _mint(to, amount);
    }

    // --- Required overrides for ERC20Votes ---

    function _update(address from, address to, uint256 value)
        internal override(ERC20, ERC20Votes)
    {
        super._update(from, to, value);
    }

    function nonces(address owner)
        public view override(ERC20Permit, Nonces)
        returns (uint256)
    {
        return super.nonces(owner);
    }
}
