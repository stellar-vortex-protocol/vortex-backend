// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @notice Minimal stand-in for the source-chain escrow, used only by the
/// Anvil integration test for EvmDepositVerifier (issue #403). It emits the
/// Deposited event the verifier expects; the real escrow is out of scope.
contract MockEscrow {
    event Deposited(
        bytes32 indexed intentId,
        address indexed token,
        address indexed depositor,
        uint256 amount,
        string user
    );

    function deposit(bytes32 intentId, address token, uint256 amount, string calldata user) external {
        emit Deposited(intentId, token, msg.sender, amount, user);
    }
}
