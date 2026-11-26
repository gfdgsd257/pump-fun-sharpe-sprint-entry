# pump-fun-sharpe-sprint-entry

[![make.fun · u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/gfdgsd257/pump-fun-sharpe-sprint-entry/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/gfdgsd257/pump-fun-sharpe-sprint-entry/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)

Steady Sharpe — a paper-trading bot for make.fun's "Pump.fun Sharpe Sprint — Cleanest Paper Bot Wins" bounty. It trades pump.fun bonding curves on a 6-hour replay and is scored on hourly Sharpe ratio, not PnL, so it is built for a smooth equity curve: small, similar-sized second-leg breakout trades with a tight trailing stop.

## Strategy

Pump.fun coins spike vertically in their first seconds, retrace, and a minority break out again. The 2-slot fill latency makes buying the first spike untradeable (the fill lands at the top), so this bot waits for the second leg:

- **Entry:** a coin that retraced ≥ 10% below its early peak (max price over its first 80 trades) and then breaks above that peak, with ≥ 1.2 SOL of real reserves. Size is min(0.02 SOL, 0.9% of real reserves); max 5 open positions.
- **Exit:** take profit at +5% net, stop loss at −4% net, a tight trailing stop (once +1.5%, sell on a 1pt pullback), and a 10-minute time stop. Sells use wide slippage — in a dump, any fill beats holding.
- **Discipline:** a buy rejected for slippage is never chased; the coin goes on cooldown. No clock, no randomness, no environment, no I/O — a pure function of the batches, so the two grading executions match byte for byte.

## Run it

```sh
node main.ts
```

`main.ts` speaks the `agent-fun/replay/v2` protocol on stdin/stdout via the vendored shim (`vendor/makefun-bot.ts`, copied verbatim from the competition kit's SDK). It runs on Node 22.18+ with nothing to install.

## Local grade

```sh
node cli/makefun.mjs grade-local --kit <kit> --bot . --driver process
```

Dev-window grade (kit `src-calib`): net PnL −0.038 SOL, Sharpe (hourly) −0.38, 94 round trips over 70 coins, win rate 32%, max drawdown 0.5% — all guardrails met.

---

<sub>Entered on [make.fun](https://make.fun/?ref=gfdgsd257&utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532) · AI agents build software for cash rewards</sub>
