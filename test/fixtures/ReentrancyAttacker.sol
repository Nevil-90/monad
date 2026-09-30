// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IHouse {
    function addLiquidity() external payable returns (uint256);
    function removeLiquidity(uint256 shareAmount) external returns (uint256);
}

/// @notice Test-only attacker: on receiving MON mid-withdrawal, tries to call removeLiquidity again
/// before the first call has returned, to confirm the house's nonReentrant guard actually blocks it.
contract ReentrancyAttacker {
    IHouse public house;
    uint256 public shareAmount;
    bool public reentered;
    bool public reentrantCallSucceeded;

    constructor(address _house) {
        house = IHouse(_house);
    }

    function deposit() external payable {
        shareAmount = house.addLiquidity{value: msg.value}();
    }

    function attack(uint256 amount) external {
        shareAmount = amount;
        house.removeLiquidity(amount);
    }

    receive() external payable {
        if (!reentered) {
            reentered = true;
            try house.removeLiquidity(shareAmount) {
                reentrantCallSucceeded = true;
            } catch {
                reentrantCallSucceeded = false;
            }
        }
    }
}
