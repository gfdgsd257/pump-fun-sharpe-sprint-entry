// Steady Sharpe — second-leg breakout scalping for the Pump.fun Sharpe Sprint.
//
// Design (see BUILD-SPEC.md in the work dir): pump.fun coins spike vertically
// in their first seconds (creator + snipers), retrace, and a minority break out
// above the early peak and run again. The 2-slot fill latency makes buying the
// first spike untradeable (the fill lands several trades later, at the top),
// so this bot waits for the SECOND leg: a coin that retraced >= 10% below its
// early peak and then breaks above that peak. Breakouts that work run fast
// (median ~17 slots to +25%); breakouts that fail dump fast, so the stop is
// tight and the target is wide.
//
// Everything here is a pure function of the batches: no clock, no randomness,
// no environment, no I/O. All money math is BigInt; ratios are plain numbers.
//
// Entry: coin retraced >= retrace below its early peak (max price over the
// first `peakTrades` trades) and now trades above that peak, young enough,
// liquid enough, with a free position slot.
// Exit:  take-profit / stop-loss / trailing stop on the *net* return of
// selling now (curve fees + tx fee included), plus a time stop.

import type { Batch, BotState, Curve, OrderInput } from './vendor/makefun-bot.ts';

export interface StrategyConfig {
  /** Entry: trades over which the early peak is measured. */
  peakTrades: number;
  /** Entry: retrace below the early peak required before a breakout counts. */
  retrace: number;
  /** Entry: enter when price recovers to within this fraction below the peak
      (0 = must break above the peak; 0.02 = enter 2% below it). */
  breakoutWithin: number;
  /** Entry: max age of a coin in slots. */
  ageMax: number;
  /** Exit: max hold in slots. */
  holdMax: number;
  /** Exit: take profit on net return. */
  tpNet: number;
  /** Exit: stop loss on net return (negative). */
  slNet: number;
  /** Exit: trailing-stop drop from the peak net, once peak >= trailArm. */
  trailDrop: number;
  trailArm: number;
  /** Max SOL (lamports) per buy. */
  sizeMaxLamports: bigint;
  /** Min real SOL reserves (lamports) a coin must have to enter. */
  minRealLamports: bigint;
  /** Min buy size (lamports). */
  minBuyLamports: bigint;
  /** Slots to wait before re-entering a mint we closed. */
  cooldownSlots: number;
  /** Exit: sell when this many consecutive sell trades arrive on a held mint
      (0 = off). Catches the start of a dump before the price gaps down. */
  flowExitSells: number;
  /** Max slippage on buy orders, bps. */
  slippageBps: number;
  /** Max slippage on sell orders, bps (wide: in a dump, any fill beats holding). */
  sellSlippageBps: number;
}

export const DEFAULT_CONFIG: StrategyConfig = {
  peakTrades: 80,
  retrace: 0.1,
  breakoutWithin: 0,
  ageMax: 6000,
  holdMax: 1500,
  tpNet: 0.05,
  slNet: -0.04,
  trailDrop: 0.01,
  trailArm: 0.015,
  sizeMaxLamports: 20_000_000n, // 0.02 SOL
  minRealLamports: 1_200_000_000n, // 1.2 SOL
  minBuyLamports: 10_500_000n, // 0.0105 SOL
  cooldownSlots: 1500,
  flowExitSells: 0,
  slippageBps: 500,
  sellSlippageBps: 10000,
};

const LAMPORTS_PER_SOL = 1_000_000_000n;
/** Base + priority tx fee per order. */
const TX_FEE = 105_000n;

const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - 1n) / b;

/** Tokens sold -> quote out before fees, floor(t*vq/(vt+t)). */
function sellQuoteOut(t: bigint, vq: bigint, vt: bigint): bigint {
  return (t * vq) / (vt + t);
}

/** Net lamports received for selling `tokens` against reserves (fees + tx fee out). */
function sellNetProceeds(tokens: bigint, curve: Curve): bigint {
  const q = sellQuoteOut(tokens, curve.virtual_quote_reserves, curve.virtual_token_reserves);
  const fee = ceilDiv(q * 95n, 10_000n) + ceilDiv(q * 30n, 10_000n);
  return q - fee - TX_FEE;
}

interface MintTrack {
  createdSlot: number | null;
  /** Max price over the first `peakTrades` trades (SOL per token). */
  peak: number;
  /** Trades seen so far. */
  trades: number;
  /** Price has dipped >= retrace below `peak` since the peak was set. */
  retraced: boolean;
  /** Last few trades' direction (true = buy), for the flow exit. */
  recent: boolean[];
}

interface OpenTrade {
  entrySlot: number;
  peakNet: number;
}

export function createStrategy(cfg: StrategyConfig = DEFAULT_CONFIG) {
  const mints = new Map<string, MintTrack>();
  const open = new Map<string, OpenTrade>();
  const cooldown = new Map<string, number>(); // mint -> slot it may re-enter at
  const pendingBuy = new Set<string>();
  const pendingSell = new Set<string>();

  function track(mint: string): MintTrack {
    let t = mints.get(mint);
    if (t === undefined) {
      t = { createdSlot: null, peak: 0, trades: 0, retraced: false, recent: [] };
      mints.set(mint, t);
    }
    return t;
  }

  function onBatch(state: BotState, batch: Batch): OrderInput[] {
    const orders: OrderInput[] = [];
    const slot = batch.slot;

    // --- fold this batch's events into per-mint tracks -------------------
    const traded = new Set<string>();
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        const t = track(e.mint);
        t.createdSlot = e.slot;
      } else if (e.event === 'TradeEvent') {
        const t = track(e.mint);
        if (t.createdSlot === null) t.createdSlot = e.slot;
        const vq = BigInt(e.virtual_quote_reserves);
        const vt = BigInt(e.virtual_token_reserves);
        t.recent.push(e.is_buy);
        if (t.recent.length > 5) t.recent.shift();
        if (vt > 0n) {
          const p = Number(vq) / Number(vt);
          if (t.trades < cfg.peakTrades) {
            // Still in the peak-formation window: extend the early peak.
            if (p > t.peak) t.peak = p;
          } else if (!t.retraced && t.peak > 0 && p <= t.peak * (1 - cfg.retrace)) {
            t.retraced = true;
          }
        }
        t.trades += 1;
        traded.add(e.mint);
      } else if (e.event === 'CompleteEvent') {
        // Curve is done; any open trade here is closed by the harness.
        open.delete(e.mint);
        cooldown.set(e.mint, slot + cfg.cooldownSlots);
      }
    }

    // --- fold fills: record entries, drop closed trades ------------------
    for (const f of batch.fills) {
      if (f.client_id.startsWith('_')) {
        // Harness close (complete / flatten / writeoff): trade is over.
        if (f.side === 'sell') {
          open.delete(f.mint);
          cooldown.set(f.mint, slot + cfg.cooldownSlots);
        }
        continue;
      }
      if (f.status === 'filled' && f.side === 'buy') {
        pendingBuy.delete(f.mint);
        // Fresh flow window: only post-entry trades count for the flow exit.
        const t = mints.get(f.mint);
        if (t !== undefined) t.recent = [];
        if (!open.has(f.mint)) open.set(f.mint, { entrySlot: f.slot, peakNet: -1 });
      } else if (f.status === 'filled' && f.side === 'sell') {
        pendingSell.delete(f.mint);
        // If the position is now empty, the trade is closed.
        if (!state.positions.has(f.mint)) {
          open.delete(f.mint);
          cooldown.set(f.mint, slot + cfg.cooldownSlots);
        }
      } else if (f.status !== 'filled' && f.side === 'buy') {
        pendingBuy.delete(f.mint);
        // A rejected/failed buy means the price ran away from the decision:
        // do not chase it at a worse price.
        if (f.reason === 'max_slippage' || f.reason === 'max_order_size') {
          cooldown.set(f.mint, slot + cfg.cooldownSlots);
        }
      } else if (f.status !== 'filled' && f.side === 'sell') {
        pendingSell.delete(f.mint);
      }
    }

    // --- exits for open positions ----------------------------------------
    for (const [mint, pos] of state.positions) {
      if (pendingSell.has(mint)) continue; // a sell is already in flight
      const trade = open.get(mint);
      if (trade === undefined) {
        // Position we did not open through a recorded buy fill (shouldn't
        // happen); treat as opened now so the time stop still applies.
        open.set(mint, { entrySlot: slot, peakNet: -1 });
        continue;
      }
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      const net = sellNetProceeds(pos.token_amount, curve);
      const netRet = Number(net - pos.cost_lamports) / Number(pos.cost_lamports);
      if (netRet > trade.peakNet) trade.peakNet = netRet;

      let sell = false;
      if (netRet >= cfg.tpNet) sell = true; // take profit
      else if (netRet <= cfg.slNet) sell = true; // stop loss
      else if (trade.peakNet >= cfg.trailArm && netRet <= trade.peakNet - cfg.trailDrop) sell = true; // trailing
      else if (slot - trade.entrySlot >= cfg.holdMax) sell = true; // time stop
      else if (cfg.flowExitSells > 0) {
        // Flow exit: consecutive sells right after entry mean the breakout
        // has no follow-through; get out before the dump cascades.
        const t = mints.get(mint);
        if (t !== undefined && t.recent.length >= cfg.flowExitSells) {
          const tail = t.recent.slice(-cfg.flowExitSells);
          if (tail.every((b) => !b)) sell = true;
        }
      }

      if (sell) {
        orders.push({
          side: 'sell',
          mint,
          token_amount: pos.token_amount,
          max_slippage_bps: cfg.sellSlippageBps,
        });
        pendingSell.add(mint);
        open.delete(mint);
        cooldown.set(mint, slot + cfg.cooldownSlots);
      }
    }

    // --- entries: second-leg breakouts ------------------------------------
    if (state.committedPositionCount() < state.hello.caps.max_open_positions) {
      for (const mint of traded) {
        if (state.committedPositionCount() + orders.length >= state.hello.caps.max_open_positions) break;
        if (orders.length >= state.hello.caps.max_orders_per_batch - 1) break;
        if (state.positions.has(mint) || pendingBuy.has(mint)) continue;
        if (open.has(mint)) continue;
        const coolUntil = cooldown.get(mint);
        if (coolUntil !== undefined && slot < coolUntil) continue;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        const t = mints.get(mint);
        if (t === undefined || t.createdSlot === null) continue;
        if (slot - t.createdSlot > cfg.ageMax) continue;
        if (t.trades < cfg.peakTrades) continue;
        if (!t.retraced) continue; // no pullback yet: this is still the first leg
        if (t.peak <= 0) continue;
        // Breakout (or near-breakout): current price within `breakoutWithin`
        // below the early peak, after a pullback.
        if (curve.virtual_token_reserves === 0n) continue;
        const now = Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
        if (now <= t.peak * (1 - cfg.breakoutWithin)) continue;

        // Liquidity: real reserves must support a >= min-buy order under the
        // 1% per-reply cap.
        const real = curve.real_quote_reserves;
        if (real < cfg.minRealLamports) continue;
        let size = (real * 9n) / 1000n; // 0.9% of real reserves
        if (size > cfg.sizeMaxLamports) size = cfg.sizeMaxLamports;
        if (size < cfg.minBuyLamports) continue;
        if (state.freeCashLamports() < size + TX_FEE) continue;

        orders.push({
          side: 'buy',
          mint,
          quote_lamports: size,
          max_slippage_bps: cfg.slippageBps,
        });
        pendingBuy.add(mint);
      }
    }

    return orders;
  }

  return { onBatch };
}
