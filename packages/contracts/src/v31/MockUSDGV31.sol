// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Local-only, ordinary non-rebasing, non-pausable USDG-6 faucet (P §5.13).
contract MockUSDGV31 is ERC20 {
    constructor() ERC20("Mock USDG v3.1", "USDG") {}

    /// @notice Native quote precision required by PS §1.
    function decimals() public pure override returns (uint8) {
        return 6;
    }

    /// @notice Local testing faucet; never part of a production USDG deployment (P §5.13).
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
