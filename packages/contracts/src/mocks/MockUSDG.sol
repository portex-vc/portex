// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Mock USDG quote asset for localhost. 6 decimals, open mint faucet.
contract MockUSDG is ERC20 {
    constructor() ERC20("Mock USDG", "USDG") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    /// @notice Open faucet — localhost only.
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
