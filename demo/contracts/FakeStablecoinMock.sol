// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title FakeStablecoinMock
/// @notice A testnet decoy that claims to be USDC, for exercising the risk engine's
///         impersonation check. It is NOT a stablecoin and holds no value.
/// @dev The engine's token screening resolves a subject's underlying token through `token()`,
///      reads `symbol()`/`decimals()`, and compares the address against the chain's canonical
///      issuer (see `CANONICAL_STABLECOINS` in worker/assess/providers/token.ts). Claiming a
///      watched symbol from a non-canonical address is exactly the pattern
///      `fake_stablecoin_suspect` exists to catch — so this contract asserts the symbol and
///      nothing else. Deploy only to testnets.
contract FakeStablecoinMock is ERC20 {
    constructor() ERC20("USD Coin", "USDC") {}

    /// @dev Six, like the real thing: the check is about the address, and matching the decimals
    ///      keeps the decoy from being dismissed on a detail the engine does not rely on.
    function decimals() public pure override returns (uint8) {
        return 6;
    }

    /// @notice Reports itself as its own underlying token.
    /// @dev This is what makes the engine treat the address as a token rather than a plain OApp:
    ///      `resolveToken` calls `token()` and screens whatever address comes back.
    function token() external view returns (address) {
        return address(this);
    }

    /// @notice Open mint, testnet only — a decoy with no supply is harder to look at in an explorer.
    function mint(address _to, uint256 _amount) external {
        _mint(_to, _amount);
    }
}
