// Steady Sharpe — a paper-trading bot for the Pump.fun Sharpe Sprint.
//
// Buys young pump.fun coins while they are being bought up, takes a small
// fixed profit, cuts losses fast, and recycles capital. Scored on hourly
// Sharpe ratio, so the design goal is a smooth equity curve: many small,
// similar-sized wins spread across the window, with tight drawdown control.
//
// Pure function of the batches: no clock, no randomness, no environment,
// no I/O. Runs on Node 22 via the kit's vendor shim (node main.ts).

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy } from './strategy.ts';

const strategy = createStrategy();

await runBot({
  onBatch(state, batch) {
    return strategy.onBatch(state, batch);
  },
});
