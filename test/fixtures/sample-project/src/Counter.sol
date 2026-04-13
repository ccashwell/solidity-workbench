// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title A simple counter contract
/// @author Uniswap Labs
/// @notice Demonstrates basic Solidity patterns for IDE testing
contract Counter {
    /// @notice The current count value
    uint256 public count;

    /// @notice The owner of this counter
    address public immutable owner;

    /// @notice Emitted when the count changes
    /// @param oldValue The previous count
    /// @param newValue The new count
    event CountChanged(uint256 indexed oldValue, uint256 indexed newValue);

    /// @notice Thrown when a non-owner tries to reset
    error NotOwner(address caller, address expectedOwner);

    /// @notice Thrown when incrementing would overflow
    error Overflow();

    modifier onlyOwner() {
        if (msg.sender != owner) {
            revert NotOwner(msg.sender, owner);
        }
        _;
    }

    constructor() {
        owner = msg.sender;
    }

    /// @notice Increment the counter by 1
    function increment() external {
        uint256 oldValue = count;
        unchecked {
            count++;
        }
        emit CountChanged(oldValue, count);
    }

    /// @notice Increment the counter by a given amount
    /// @param amount The amount to increment by
    function incrementBy(uint256 amount) external {
        uint256 oldValue = count;
        count += amount;
        emit CountChanged(oldValue, count);
    }

    /// @notice Reset the counter to zero (owner only)
    function reset() external onlyOwner {
        uint256 oldValue = count;
        count = 0;
        emit CountChanged(oldValue, 0);
    }

    /// @notice Get the current count
    /// @return The current count value
    function getCount() external view returns (uint256) {
        return count;
    }
}
