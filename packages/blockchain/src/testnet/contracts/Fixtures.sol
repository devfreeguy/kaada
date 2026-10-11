// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// TESTNET FIXTURES ONLY (Celo Sepolia). Not audited, not for any real value.

/// A bare ERC-20 with a public mint, so a test can fund exactly the wallet it needs.
contract TestToken {
    string public name;
    string public symbol;
    uint8 public immutable decimals;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(string memory n, string memory s, uint8 d) {
        name = n;
        symbol = s;
        decimals = d;
    }

    function mint(address to, uint256 amount) external {
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _move(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        require(allowed >= amount, "allowance");
        if (allowed != type(uint256).max) allowance[from][msg.sender] = allowed - amount;
        _move(from, to, amount);
        return true;
    }

    function _move(address from, address to, uint256 amount) internal {
        require(balanceOf[from] >= amount, "balance");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }
}

/// Stands in for the provider's reactor + swap target: it pulls the APPROVED sell token from the caller
/// and pays the buy token out of its own stock. So an approval is consumed for real and a missing or
/// too-small approval makes the swap revert.
contract MockSwap {
    function swap(address tokenIn, uint256 amountIn, address tokenOut, uint256 amountOut) external {
        require(TestToken(tokenIn).transferFrom(msg.sender, address(this), amountIn), "pull");
        require(TestToken(tokenOut).transfer(msg.sender, amountOut), "pay");
    }
}
