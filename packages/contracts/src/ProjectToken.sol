// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";

/// @notice Per-raise project token. ERC-20, 18 decimals, fixed supply minted once to the raise.
///         Deployed as an EIP-1167 clone by RaiseFactory and initialised once.
///         Only the raise (redeem burn) and the pool (post-migration burn) may burn their own holdings.
contract ProjectToken is ERC20Upgradeable {
    address public raise;
    address public pool;

    event PoolSet(address indexed pool);

    error OnlyRaise();
    error OnlyRaiseOrPool();

    modifier onlyRaise() {
        if (msg.sender != raise) revert OnlyRaise();
        _;
    }

    constructor() {
        _disableInitializers();
    }

    /// @notice Mints the entire fixed supply to `raise_`. Called once by the factory.
    function initialize(string memory name_, string memory symbol_, uint256 totalSupply_, address raise_)
        external
        initializer
    {
        __ERC20_init(name_, symbol_);
        raise = raise_;
        _mint(raise_, totalSupply_);
    }

    function setPool(address pool_) external onlyRaise {
        pool = pool_;
        emit PoolSet(pool_);
    }

    /// @notice Burn tokens held by the raise (redeemed tranches) or by the pool (post-migration
    ///         leftover inventory). Burns from the caller's own balance only.
    function burn(uint256 amount) external {
        if (msg.sender != raise && msg.sender != pool) revert OnlyRaiseOrPool();
        _burn(msg.sender, amount);
    }
}
