# DeFi Lending Protocol

[![CI — Compile & Test](https://github.com/NicoMM8/defi-lending-protocol/actions/workflows/test.yml/badge.svg)](https://github.com/NicoMM8/defi-lending-protocol/actions/workflows/test.yml)
[![Solidity](https://img.shields.io/badge/Solidity-0.8.24-363636?logo=solidity)](https://soliditylang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

A fully-featured **decentralized lending protocol** built on Solidity, featuring dynamic interest rates, Chainlink oracle integration, partial liquidations, and ERC-3156 flash loans.

Inspired by the architecture of [Aave](https://aave.com) and [Compound](https://compound.finance), this project demonstrates production-grade DeFi patterns including WAD fixed-point arithmetic, multi-asset health factor calculations, and off-chain keeper bots.

---

## Architecture

The protocol consists of three core components:
- **LendingPool**: Manages deposits, borrows, repayments, and liquidations.
- **InterestRateModel**: Multi-slope kinked model for dynamic rates.
- **PriceOracleWrapper**: Chainlink integration with staleness protection.

---

## Features

| Feature | Implementation |
|---|---|
| **Dynamic Interest Rates** | Two-slope kinked model — gentle below 80% utilization, steep above. Rates accrue per-second via a compounding `borrowIndex`. |
| **Chainlink Price Feeds** | All prices normalized to 18 decimals (WAD). Oracle includes a configurable **staleness guard** (default: 1 hour) to reject outdated data. |
| **Health Factor** | Multi-asset HF computed as: `Σ(collateral × price × LTV) / Σ(debt × price)`. Positions with HF < 1.0 are eligible for liquidation. |
| **Partial Liquidations** | **Close Factor (50%)** limits each liquidation call to half the outstanding debt, preventing full position wipeout in a single transaction. |
| **Reserve Factor (10%)** | Protocol retains 10% of accrued interest as reserves. Remaining 90% flows to depositors via the supply rate. |
| **Supply APY** | `supplyRate = borrowRate × utilization × (1 − reserveFactor)` — depositors earn yield automatically. |
| **Flash Loans (ERC-3156)** | Uncollateralized loans with a 0.09% fee, repaid atomically within the same transaction. |
| **Emergency Controls** | `Ownable` for admin functions, `Pausable` for circuit-breaking all user operations. |
| **Reentrancy Protection** | All state-changing functions protected via OpenZeppelin's `ReentrancyGuard`. |

---

## Project Structure

```
contracts/
├── LendingPool.sol              Core protocol: deposit, borrow, repay, withdraw, liquidate, flashLoan
├── InterestRateModel.sol        Kinked (two-slope) interest rate mathematics
├── PriceOracleWrapper.sol       Chainlink integration with staleness protection
├── ArbitrageBot.sol             Flash loan receiver — arbitrage demo
├── MaliciousFlashBorrower.sol   Security test: verifies unpaid flash loans revert
├── MockAggregator.sol           Test helper: simulates Chainlink price feeds
└── MockERC20.sol                Test helper: mintable ERC-20 token

scripts/
├── deploy.js                    Full protocol deployment → deployed-addresses.json
├── arbitrageSimulation.js       End-to-end flash loan arbitrage demo
├── liquidationSimulation.js     Liquidation flow with Close Factor demo
└── liquidationBot.js            Off-chain keeper bot (Node.js)

test/
└── DeFiProtocol.test.js         28 test cases across 11 categories

.github/workflows/
└── test.yml                     CI: compile + test on push/PR
```

---

## Quick Start

```bash
# Clone and install
git clone https://github.com/NicoMM8/defi-lending-protocol.git
cd defi-lending-protocol
npm install

# Compile contracts
npx hardhat compile

# Run the full test suite (28 tests)
npm test

# Deploy locally
npx hardhat run scripts/deploy.js

# Run simulations
npm run simulate:arb    # Flash loan arbitrage
npm run simulate:liq    # Liquidation with Close Factor
```

---

## Interest Rate Model

The protocol uses a **kinked (two-slope) model** inspired by Aave and Compound. Borrowing rates remain low under normal utilization but increase sharply when the pool approaches full utilization, incentivizing repayments.

The protocol uses a two-slope model where borrow rates stay low until 80% utilization (the kink), then increase sharply to incentivize liquidity.

Supply rates are calculated based on the total interest paid by borrowers, minus a 10% reserve factor.

---

## Security Considerations

| Mechanism | Purpose |
|---|---|
| **Ownable** | Only the deployer can add markets, pause the protocol, and configure oracle feeds |
| **Pausable** | Emergency circuit breaker — halts all user-facing operations |
| **ReentrancyGuard** | Prevents reentrancy on every external call that modifies state |
| **Oracle Staleness** | Configurable `maxStaleness` (default: 3600s) rejects stale Chainlink data |
| **Close Factor** | 50% cap per liquidation call prevents flash-liquidation attacks |
| **WAD Arithmetic** | All calculations use 18-decimal fixed-point math (1e18) to avoid precision loss |

> **Note**: This is an educational project and has not been audited. Use at your own risk.

---

## Common Issues & Solutions

| Issue                               | Solution                                                                                                                                                                                             |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Transaction Reverts: "Health factor too low"** | You are attempting to withdraw collateral or borrow debt that would put your position underwater (HF < 1.0). Deposit more collateral or repay some debt first.                                       |
| **Transaction Reverts: "Stale price data"** | The Chainlink oracle hasn't updated within the `maxStaleness` window (default 1h). If testing locally, ensure you are using a recent mainnet fork or update the price feed manually via `MockAggregator`. |
| **Flash Loan Fails: "Arbitrage failed"** | The flash loan receiver (bot) was unable to repay the loan + fee. Ensure the bot contract is funded with enough tokens to cover the fee if the trade profit is insufficient.                        |
| **Price Oracle: "Invalid price"**     | The oracle returned a zero or negative price. Check the feed address and ensure the asset is correctly listed.                                                                                       |

---

## Built With

- [Solidity ^0.8.20](https://soliditylang.org/) — Smart contract language
- [Hardhat](https://hardhat.org/) — Development and testing framework
- [OpenZeppelin Contracts v5](https://www.openzeppelin.com/contracts) — Security primitives and ERC standards
- [Chainlink](https://chain.link/) — Decentralized oracle price feeds
- [Ethers.js v6](https://docs.ethers.org/) — Ethereum interaction library

---

## License

This project is licensed under the [MIT License](./LICENSE).
