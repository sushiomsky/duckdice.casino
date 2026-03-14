const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("DuckDiceBank", function () {
  it("accepts deposits and settles wins", async function () {
    const [owner, player] = await ethers.getSigners();
    const Factory = await ethers.getContractFactory("DuckDiceBank");
    const bank = await Factory.deploy();

    await owner.sendTransaction({ to: bank.target, value: ethers.parseEther("1") });
    expect(await ethers.provider.getBalance(bank.target)).to.equal(ethers.parseEther("1"));

    await expect(() => bank.settleWin(player.address, ethers.parseEther("0.1"))).to.changeEtherBalance(
      player,
      ethers.parseEther("0.1")
    );
  });
});
