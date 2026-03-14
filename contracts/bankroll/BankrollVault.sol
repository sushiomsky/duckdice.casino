// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract BankrollVault {
    address public owner;
    mapping(address => uint256) public liquidityShares;
    uint256 public totalLiquidity;

    event LiquidityAdded(address indexed provider, uint256 amount);
    event LiquidityRemoved(address indexed provider, uint256 amount);
    event BetSettled(address indexed player, uint256 payout, bytes32 indexed betId);

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    constructor(address initialOwner) {
        owner = initialOwner;
    }

    receive() external payable {
        liquidityShares[msg.sender] += msg.value;
        totalLiquidity += msg.value;
        emit LiquidityAdded(msg.sender, msg.value);
    }

    function removeLiquidity(uint256 amount) external {
        require(liquidityShares[msg.sender] >= amount, "insufficient share");
        require(address(this).balance >= amount, "insufficient vault balance");

        liquidityShares[msg.sender] -= amount;
        totalLiquidity -= amount;

        (bool ok, ) = payable(msg.sender).call{value: amount}("");
        require(ok, "withdraw failed");
        emit LiquidityRemoved(msg.sender, amount);
    }

    function settleWin(address payable player, uint256 payout, bytes32 betId) external onlyOwner {
        require(address(this).balance >= payout, "insufficient vault balance");
        (bool ok, ) = player.call{value: payout}("");
        require(ok, "payout failed");
        emit BetSettled(player, payout, betId);
    }

    function setOwner(address newOwner) external onlyOwner {
        owner = newOwner;
    }
}
