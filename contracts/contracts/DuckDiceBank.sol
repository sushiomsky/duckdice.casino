// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract DuckDiceBank {
    address public owner;
    mapping(address => uint256) public balances;

    event Deposited(address indexed from, uint256 amount);
    event Settled(address indexed player, uint256 payout);

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    constructor() {
        owner = msg.sender;
    }

    receive() external payable {
        balances[msg.sender] += msg.value;
        emit Deposited(msg.sender, msg.value);
    }

    function settleWin(address payable player, uint256 payout) external onlyOwner {
        require(address(this).balance >= payout, "insufficient balance");
        (bool ok,) = player.call{value: payout}("");
        require(ok, "transfer failed");
        emit Settled(player, payout);
    }
}
