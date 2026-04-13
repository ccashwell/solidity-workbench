// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console2} from "forge-std/Test.sol";
import {Counter} from "../src/Counter.sol";

contract CounterTest is Test {
    Counter public counter;
    address public alice = makeAddr("alice");

    event CountChanged(uint256 indexed oldValue, uint256 indexed newValue);

    function setUp() public {
        counter = new Counter();
    }

    function test_InitialCountIsZero() public view {
        assertEq(counter.count(), 0);
    }

    function test_Increment() public {
        vm.expectEmit(true, true, false, false);
        emit CountChanged(0, 1);

        counter.increment();
        assertEq(counter.count(), 1);
    }

    function test_IncrementBy() public {
        counter.incrementBy(42);
        assertEq(counter.count(), 42);
    }

    function test_Reset() public {
        counter.increment();
        counter.increment();
        assertEq(counter.count(), 2);

        counter.reset();
        assertEq(counter.count(), 0);
    }

    function test_RevertWhen_NonOwnerResets() public {
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(Counter.NotOwner.selector, alice, address(this))
        );
        counter.reset();
    }

    function testFuzz_IncrementBy(uint256 amount) public {
        amount = bound(amount, 0, type(uint128).max);
        counter.incrementBy(amount);
        assertEq(counter.count(), amount);
    }

    function test_OwnerIsDeployer() public view {
        assertEq(counter.owner(), address(this));
    }
}
