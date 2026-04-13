// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Counter interface
/// @notice Interface for the Counter contract — used to test
///         go-to-definition, implement-interface code action, etc.
interface ICounter {
    event CountChanged(uint256 indexed oldValue, uint256 indexed newValue);

    error NotOwner(address caller, address expectedOwner);
    error Overflow();

    function increment() external;
    function incrementBy(uint256 amount) external;
    function reset() external;
    function getCount() external view returns (uint256);
    function count() external view returns (uint256);
    function owner() external view returns (address);
}
