/**
 * snipe_bot_ws_raw_gmgn.js — v7-virtual-verbose
 *
 * - Mode VIRTUEL (paper): aucune tx envoyée, PnL estimé, logs live MTM
 * - WS Helius: logsSubscribe + signatureSubscribe + accountSubscribe (réserves)
 * - Early Route Probe + garde-fous route (slippage/min-out/impact)
 * - Pré-submit: stabilité des réserves (anti withdraw immédiat)
 * - Post-buy: écoute logs + accounts (drop réserves) → SELL (réel ou virtuel)
 * - Post-buy: sondage SELL (no route / ratio qui s’écroule) → SELL
 * - Holders guard: top1/top10 hors réserves (pré-buy + re-check post-buy)
 * - Timeout de sortie + rug-guard prix
 */

import 'dotenv/config';
import express from 'express';
import bodyParser from 'body-parser';
import fetch from 'node-fetch';
import fs from 'fs';
import bs58 from 'bs58';
import WebSocket from 'ws';
import {
  Connection,
  PublicKey,
  Keypair,
  LAMPORTS_PER_SOL,
  VersionedTransaction,
} from '@solana/web3.js';

/* ====================== Config ====================== */
const CFG = {
  PORT: Number(process.env.PORT || 10000),

  // RPC HTTP
  RPC_URL: process.env.RPC_URL || 'https://api.mainnet-beta.solana.com',

  // WebSocket Helius
  HELIUS_WS_URL: process.env.HELIUS_WS_URL || '',

  // Commitments
  SIGNATURE_COMMITMENT: (process.env.SIGNATURE_COMMITMENT || 'processed'),
  TX_FETCH_COMMITMENT: (process.env.TX_FETCH_COMMITMENT || 'confirmed'),

  // Filtres d'entrée
  MAX_POOL_AGE_MS: Number(process.env.MAX_POOL_AGE_MS || 2500),
  TRIGGER_MIN_SOL: Number(process.env.TRIGGER_MIN_SOL || 200),
  PUMP_TRIGGER_MIN_SOL: Number(process.env.PUMP_TRIGGER_MIN_SOL || 350),

  // Trade
  TRADE_SIZE_SOL: Number(process.env.TRADE_SIZE_SOL || 0.20),
  MAX_SLIPPAGE: Number(process.env.MAX_SLIPPAGE || 0.30),

  // Priority fees (BUY/SELL distincts possibles)
  PRIORITY_FEE_SOL: Number(process.env.PRIORITY_FEE_SOL || 0.006), // fallback
  PRIORITY_FEE_BUY: (process.env.PRIORITY_FEE_BUY !== undefined ? Number(process.env.PRIORITY_FEE_BUY) : undefined),
  PRIORITY_FEE_SELL: (process.env.PRIORITY_FEE_SELL !== undefined ? Number(process.env.PRIORITY_FEE_SELL) : undefined),
  ANTI_MEV: ['1','true','yes'].includes(String(process.env.ANTI_MEV || '').toLowerCase()),

  // Sortie
  EXIT_TIMEOUT_MS: Number(process.env.EXIT_TIMEOUT_MS || 15000),

  // Garde-fous route (GMGN)
  MAX_PRICE_IMPACT_PCT: Number(process.env.MAX_PRICE_IMPACT_PCT || 22),
  MIN_OTHER_OVER_OUT: Number(process.env.MIN_OTHER_OVER_OUT || 0.965),
  MIN_OUT_PER_SOL: Number(process.env.MIN_OUT_PER_SOL || 0),

  // Relâche précoce (optionnelle)
  EARLY_RELAX_GUARDS_MS: Number(process.env.EARLY_RELAX_GUARDS_MS || 2000),
  EARLY_MIN_OTHER_OVER_OUT: Number(process.env.EARLY_MIN_OTHER_OVER_OUT || 0.72),

  // Early route probe
  EARLY_ROUTE_PROBE_MS: Number(process.env.EARLY_ROUTE_PROBE_MS || 3000),
  EARLY_ROUTE_PROBE_INTERVAL_MS: Number(process.env.EARLY_ROUTE_PROBE_INTERVAL_MS || 120),

  // Rug-guard prix
  RUG_GUARD_WINDOW_MS: Number(process.env.RUG_GUARD_WINDOW_MS || 2000),
  RUG_DROP_PCT: Number(process.env.RUG_DROP_PCT || 30),

  // GMGN
  GMGN_HOST: process.env.GMGN_HOST || 'https://gmgn.ai',

  // Wallet
  WALLET_SECRET_KEY: process.env.WALLET_SECRET_KEY || '',
  BASE_SOL_MINT: 'So11111111111111111111111111111111111111112',

  // Logs/CSV
  CSV_FILE: process.env.CSV_FILE || 'live_trades.csv',
  LOG_LEVEL: (process.env.LOG_LEVEL || 'info').toLowerCase(),

  // AMM programs
  AMM_PROGRAM_IDS: (process.env.AMM_PROGRAM_IDS || '')
    .split(',').map(s => s.trim()).filter(Boolean),

  // Motifs de logs
  WS_REQUIRE_PATTERN: ['1','true','yes'].includes(String(process.env.WS_REQUIRE_PATTERN || 'true').toLowerCase()),
  POOL_LOG_PATTERNS: (process.env.POOL_LOG_PATTERNS || [
    'create_pool','CreatePool','createPool',
    'InitializePool','initialize_pool','initializePool',
    'AddLiquidity','add_liquidity','addLiquidity',
    'Initialize Whirlpool','InitializeConfig','OpenPosition',
  ].join('|')),

  // File RPC HTTP
  RPC_RPS: Number(process.env.RPC_RPS || 2),
  RPC_MAX_CONCURRENCY: Number(process.env.RPC_MAX_CONCURRENCY || 1),
  RPC_BACKOFF_MS: Number(process.env.RPC_BACKOFF_MS || 800),
  RPC_BACKOFF_MAX_MS: Number(process.env.RPC_BACKOFF_MAX_MS || 5000),

  /* ====== Anti-withdraw params ====== */
  PRE_SUBMIT_STABILITY_MS: Number(process.env.PRE_SUBMIT_STABILITY_MS || 350),
  PRE_SUBMIT_POLLS: Number(process.env.PRE_SUBMIT_POLLS || 3),
  PRE_SUBMIT_DROP_PCT: Number(process.env.PRE_SUBMIT_DROP_PCT || 6),
  POST_SUBSCRIBE_MONITOR_MS: Number(process.env.POST_SUBSCRIBE_MONITOR_MS || 15000),
  POOL_TOKEN_MIN_BALANCE: Number(process.env.POOL_TOKEN_MIN_BALANCE || 10),

  /* ====== Account drop trigger ====== */
  ACCT_DROP_PCT_TRIGGER: Number(process.env.ACCT_DROP_PCT_TRIGGER || 15),

  /* ====== Holders concentration ====== */
  TOP1_HOLDER_MAX_PCT: Number(process.env.TOP1_HOLDER_MAX_PCT || 40),
  TOP10_HOLDER_MAX_PCT: Number(process.env.TOP10_HOLDER_MAX_PCT || 85),
  HOLDER_CHECK_PREBUY: ['1','true','yes'].includes(String(process.env.HOLDER_CHECK_PREBUY || 'true').toLowerCase()),
  HOLDER_CHECK_POSTBUY_MS: Number(process.env.HOLDER_CHECK_POSTBUY_MS || 2000),

  /* ====== Virtual / Paper mode ====== */
  VIRTUAL_MODE: ['1','true','yes'].includes(String(process.env.VIRTUAL_MODE || 'false').toLowerCase()),
  VIRTUAL_NOTE: String(process.env.VIRTUAL_NOTE || ''),
  VIRTUAL_VERBOSE: ['1','true','yes'].includes(String(process.env.VIRTUAL_VERBOSE || 'true').toLowerCase()),
  VIRTUAL_MTM_MS: Number(process.env.VIRTUAL_MTM_MS || 800),
  VIRTUAL_MTM_CHANGE_PCT: Number(process.env.VIRTUAL_MTM_CHANGE_PCT || 2.5),
};

/* ====================== Logger ====================== */
const dbg  = (...a) => { if (CFG.LOG_LEVEL === 'debug') console.log(...a); };
const info = (...a) => console.log(...a);
const warn = (...a) => console.warn(...a);
const err  = (...a) => console.error(...a);

const lastErr = new Map();
function errOnce(key, ...msg) {
  const now = Date.now();
  const last = lastErr.get(key) || 0;
  if (now - last > 2000) { lastErr.set(key, now); err(...msg); }
  else { dbg(...msg); }
}

if (!CFG.WALLET_SECRET_KEY) { err('❌ WALLET_SECRET_KEY manquant'); process.exit(1); }
if (!CFG.HEIUS_WS_URL && !CFG.HELIUS_WS_URL) {} // noop
if (!CFG.HELIUS_WS_URL) { err('❌ HELIUS_WS_URL manquant'); process.exit(1); }

if (!fs.existsSync(CFG.CSV_FILE)) fs.writeFileSync(CFG.CSV_FILE, 'time,event,side,sol,token,extra\n');
const csv = (r) => {
  const line = `${new Date().toISOString()},${r.event},${r.side||''},${r.sol||''},${r.token||''},${(r.extra||'').toString().replace(/\n/g,' ')}\n`;
  fs.appendFileSync(CFG.CSV_FILE, line);
};

/* ====================== Setup ====================== */
const connection = new Connection(CFG.RPC_URL, { commitment: 'confirmed' });
const wallet = Keypair.fromSecretKey(bs58.decode(CFG.WALLET_SECRET_KEY));
const WALLET_PK = wallet.publicKey.toBase58();

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const fmt = (n, d=6) => (typeof n === 'number' ? Number(n).toFixed(d) : n);
const PK_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/* ====================== Globals ====================== */
const poolAddrToMint = new Map();   // pool token account addr -> mint we bought
const mintToPoolAddrs = new Map();  // mint -> [pool token account addrs]

/* ===== Virtual positions (in-memory) + trackers ===== */
const VIRT = {
  open: new Map(),      // mint -> { ts, inSol, expOutTokens, entryRatio, poolAddrs, note }
  history: [],
  trackers: new Map(),  // mint -> { timer, lastOutSol }
};

/* ====================== File HTTP ====================== */
class HttpBucket {
  constructor({ rps, concurrency, backoffMs, backoffMax }) {
    this.interval = Math.max(1000 / Math.max(1, rps), 80);
    this.maxConc = Math.max(1, concurrency);
    this.backoffStart = Math.max(200, backoffMs);
    this.backoffMax = Math.max(this.backoffStart, backoffMax);
    this.queue = [];
    this.running = 0;
    setInterval(() => this._drain(), this.interval);
  }
  push(fn, tag='') {
    return new Promise((resolve) => {
      this.queue.push({ fn, resolve, tag, backoff: this.backoffStart });
      this._drain();
    });
  }
  async _drain() {
    while (this.running < this.maxConc && this.queue.length) {
      const task = this.queue.shift();
      this.running++;
      (async () => {
        try {
          const out = await task.fn();
          task.resolve(out);
        } catch (e) {
          const m = String(e?.message||'');
          if (m.includes('429') || m.includes('rate limited')) {
            errOnce('429', `429 rate-limited, retry in ${task.backoff}ms`);
            await sleep(task.backoff);
            task.backoff = Math.min(task.backoff * 2, this.backoffMax);
            this.queue.push(task);
          } else {
            dbg('[HTTP err]', m);
            task.resolve(null);
          }
        } finally {
          this.running--;
        }
      })();
    }
  }
}
const httpBucket = new HttpBucket({
  rps: CFG.RPC_RPS,
  concurrency: CFG.RPC_MAX_CONCURRENCY,
  backoffMs: CFG.RPC_BACKOFF_MS,
  backoffMax: CFG.RPC_BACKOFF_MAX_MS,
});

async function getTransactionOnce(sig, commitment = 'confirmed') {
  return await httpBucket.push(
    () => connection.getTransaction(sig, { commitment, maxSupportedTransactionVersion: 0 }),
    `getTx:${commitment}`,
  );
}
async function getTransactionWithFallback(sig) {
  let tx = await getTransactionOnce(sig, 'confirmed');
  if (tx) return tx;
  await sleep(250);
  return await getTransactionOnce(sig, 'finalized');
}

/* ====================== Helpers extraction ====================== */
function tsFromTxMs(tx) {
  const t = tx?.blockTime;
  return (t ? Number(t) * 1000 : Date.now());
}
function poolAgeFromTxMs(tx) { return Date.now() - tsFromTxMs(tx); }
function estimateSolAddedFromTx(tx) {
  const pre = tx?.meta?.preBalances || []; const post = tx?.meta?.postBalances || [];
  if (!pre.length || !post.length) return 0;
  let delta = 0; for (let i=0;i<post.length;i++) { const d = (post[i] - (pre[i]||0)); if (d > 0) delta += d / LAMPORTS_PER_SOL; }
  return delta;
}
function extractMintFromTx(tx) {
  const pre = tx?.meta?.preTokenBalances || []; const post = tx?.meta?.postTokenBalances || [];
  const by = new Map();
  for (const p of post) {
    const mint = p.mint;
    const postAmt = Number(p.uiTokenAmount?.uiAmount || 0);
    const preEntry = pre.find(x => x.accountIndex === p.accountIndex);
    const preAmt = preEntry ? Number(preEntry.uiTokenAmount?.uiAmount || 0) : 0;
    const delta = postAmt - preAmt;
    if (delta > 0) by.set(mint, (by.get(mint)||0) + delta);
  }
  if (!by.size) return null;
  return [...by.entries()].sort((a,b)=>b[1]-a[1])[0][0];
}
function collectProgramsFromTx(tx) {
  const seen = new Set();
  const keys = tx?.transaction?.message?.accountKeys || [];
  for (const ins of (tx?.transaction?.message?.instructions || [])) {
    if (ins.programId) seen.add(String(ins.programId));
    if (ins.programIdIndex !== undefined && keys[ins.programIdIndex]) seen.add(String(keys[ins.programIdIndex]));
  }
  for (const grp of (tx?.meta?.innerInstructions || [])) {
    for (const ins of (grp.instructions || [])) {
      if (ins.programId) seen.add(String(ins.programId));
      if (ins.programIdIndex !== undefined && keys[ins.programIdIndex]) seen.add(String(keys[ins.programIdIndex]));
    }
  }
  return [...seen];
}

/* ====================== GMGN helpers ====================== */
async function gmgnGetRouteRaw(params) {
  const url = `${CFG.GMGN_HOST}/defi/router/v1/sol/tx/get_swap_route?${params.toString()}`;
  return await httpBucket.push(async () => {
    const res = await fetch(url);
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, data, status: res.status };
  }, 'gmgn:get_route');
}
async function gmgnGetRoute({ tokenIn, tokenOut, inLamports, fromAddress, slippagePct, feeSol, isAntiMev=false }) {
  const params = new URLSearchParams({
    token_in_address: tokenIn,
    token_out_address: tokenOut,
    in_amount: String(inLamports),
    from_address: fromAddress,
    slippage: String(slippagePct * 100),
    swap_mode: 'ExactIn',
  });
  if (feeSol && feeSol > 0) params.set('fee', String(feeSol));
  if (isAntiMev) params.set('is_anti_mev', 'true');

  const t0 = Date.now();
  const maxMs = Math.max(200, CFG.EARLY_ROUTE_PROBE_MS);
  const baseInt = Math.max(60, CFG.EARLY_ROUTE_PROBE_INTERVAL_MS);
  let lastErr = '';

  while (Date.now() - t0 < maxMs) {
    const { ok, data, status } = await gmgnGetRouteRaw(params);
    const good = ok && data && data.code === 0 && data.data?.raw_tx?.swapTransaction;
    const outAmt = Number(data?.data?.quote?.outAmount || 0);

    if (good && outAmt > 0) return data.data;

    lastErr = `GMGN route invalid: ${JSON.stringify(data)} {status:${status}}`;

    const msg = String(data?.msg || '').toLowerCase();
    if (msg.includes('little pool') || outAmt === 0) {
      const jitter = Math.floor(Math.random() * 50);
      await sleep(baseInt + jitter);
      continue;
    }
    break;
  }
  throw new Error(lastErr);
}
async function gmgnSubmitSignedTx(base64Signed, isAntiMev=false) {
  const body = { chain: 'sol', signedTx: base64Signed };
  if (isAntiMev) body.isAntiMev = true;
  const res = await fetch(`${CFG.GMGN_HOST}/txproxy/v1/send_transaction`, {
    method: 'POST', headers: { 'content-type':'application/json' }, body: JSON.stringify(body),
  });
  const data = await res.json().catch(()=> ({}));
  if (!res.ok || data.code !== 0) throw new Error(`GMGN submit error: ${JSON.stringify(data)} {status:${res.status}}`);
  return data.data;
}
async function gmgnCheckStatus({ hash, lastValidBlockHeight }) {
  const url = `${CFG.GMGN_HOST}/defi/router/v1/sol/tx/get_transaction_status?hash=${hash}&last_valid_height=${lastValidBlockHeight}`;
  const res = await fetch(url);
  const data = await res.json().catch(()=> ({}));
  if (!res.ok || data.code !== 0) throw new Error(`GMGN status error: ${JSON.stringify(data)} {status:${res.status}}`);
  return data.data;
}
function ratioOutOverIn(q) { const out = Number(q?.outAmount || 0); const inp = Number(q?.inAmount || 0); return (inp>0? out/inp : 0); }
function assertRouteGuards(routeData) {
  const q = routeData.quote || {};
  const impactPct = Number(q?.priceImpactPct || 0) * 100;
  const out = Number(q?.outAmount || 0);
  const other = Number(q?.otherAmountThreshold || 0);

  if (impactPct > CFG.MAX_PRICE_IMPACT_PCT) {
    throw new Error(`route-guard: priceImpact ${impactPct.toFixed(2)}% > ${CFG.MAX_PRICE_IMPACT_PCT}%`);
  }
  if (out > 0) {
    const minRatio = Math.max(0, (1 - CFG.MAX_SLIPPAGE) - 0.01);
    const ratioOther = other / out;
    if (ratioOther + 1e-6 < minRatio) {
      throw new Error(`route-guard: other/out ${ratioOther.toFixed(3)} < ${minRatio.toFixed(3)} (slippage)`);
    }
  }
}

/* ====================== Anti-withdraw helpers ====================== */
const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

async function isTokenAccount(pubkeyStr) {
  try {
    const info = await connection.getParsedAccountInfo(new PublicKey(pubkeyStr), 'confirmed');
    const val = info.value;
    if (!val) return false;
    if (val?.owner?.toBase58 && String(val.owner?.toBase58()) === TOKEN_PROGRAM_ID) return true;
    if (val?.data?.program === 'spl-token') return true;
    if (val?.data?.parsed?.type === 'account') return true;
    return false;
  } catch { return false; }
}
async function getTokenUiAmount(pubkeyStr) {
  try {
    const info = await connection.getParsedAccountInfo(new PublicKey(pubkeyStr), 'confirmed');
    const data = info.value?.data;
    const parsed = data?.parsed;
    if (parsed?.info?.tokenAmount) {
      return Number(parsed.info.tokenAmount.uiAmount || 0);
    }
    return 0;
  } catch { return 0; }
}
async function extractPoolTokenAccountsFromRawBase64(base64Raw) {
  try {
    const buf = Buffer.from(base64Raw, 'base64');
    const tx = VersionedTransaction.deserialize(buf);
    const keys = tx.message.accountKeys.map(k => k.toBase58());
    const tokenAccounts = [];
    for (const k of keys) {
      if (!PK_RE.test(k)) continue;
      const isTok = await isTokenAccount(k);
      if (isTok) {
        const amt = await getTokenUiAmount(k);
        if (amt >= CFG.POOL_TOKEN_MIN_BALANCE) tokenAccounts.push({ addr: k, uiAmount: amt });
      }
    }
    return tokenAccounts;
  } catch { return []; }
}
async function preSubmitLiquidityStabilityCheck(rawBase64) {
  const tokenAccounts = await extractPoolTokenAccountsFromRawBase64(rawBase64);
  if (!tokenAccounts.length) {
    dbg('[PRECHECK] no pool token accounts found — skipping');
    return true;
  }
  const polls = Math.max(1, CFG.PRE_SUBMIT_POLLS);
  const totalMs = Math.max(0, CFG.PRE_SUBMIT_STABILITY_MS);
  const waitMs = (polls > 1) ? Math.floor(totalMs / (polls - 1)) : 0;

  const snaps = [];
  for (let i = 0; i < polls; i++) {
    const snap = {};
    for (const t of tokenAccounts) snap[t.addr] = await getTokenUiAmount(t.addr);
    snaps.push(snap);
    if (i < polls - 1 && waitMs > 0) await sleep(waitMs);
  }

  for (const addr of Object.keys(snaps[0])) {
    let maxV = -Infinity, minV = Infinity;
    for (const s of snaps) {
      const v = Number(s[addr] || 0);
      if (v > maxV) maxV = v;
      if (v < minV) minV = v;
    }
    if (maxV <= 0) return false;
    const dropPct = (1 - (minV / maxV)) * 100;
    dbg(`[PRECHECK] ${addr} drop=${dropPct.toFixed(2)}%`);
    if (dropPct >= CFG.PRE_SUBMIT_DROP_PCT) {
      warn(`[PRECHECK] liquidity drop ${dropPct.toFixed(2)}% ≥ ${CFG.PRE_SUBMIT_DROP_PCT}% → abort buy`);
      return false;
    }
  }
  return true;
}

/* ====================== Holders concentration ====================== */
async function getLargestHoldersMetrics(mint, { excludeAddrs = [] } = {}) {
  try {
    const mintPk = new PublicKey(mint);
    const [largest, supplyInfo] = await Promise.all([
      connection.getTokenLargestAccounts(mintPk, 'confirmed'),
      connection.getTokenSupply(mintPk, 'confirmed'),
    ]);
    const supply = Number(supplyInfo?.value?.uiAmount || 0);
    const list = largest?.value || [];
    if (!supply || !list.length) {
      return { ok:false, reason:'no-supply-or-largest', supply:0, top1Pct:0, top10Pct:0 };
    }
    const ex = new Set(excludeAddrs);
    const top = [];
    for (const it of list) {
      const addr = it?.address?.toBase58 ? it.address.toBase58() : String(it.address || '');
      const amt  = Number(it?.uiAmount || 0);
      if (!addr || !Number.isFinite(amt)) continue;
      if (ex.has(addr)) continue;
      top.push({ addr, amt });
    }
    top.sort((a,b)=> b.amt - a.amt);
    const top1 = top[0]?.amt || 0;
    const top10 = top.slice(0,10).reduce((s,x)=> s + x.amt, 0);
    const top1Pct  = supply>0 ? (top1 / supply) * 100 : 0;
    const top10Pct = supply>0 ? (top10 / supply) * 100 : 0;
    return { ok:true, supply, top1Pct, top10Pct, top, excluded: excludeAddrs };
  } catch (e) {
    warn('holders metrics error:', e.message);
    return { ok:false, reason:e.message, supply:0, top1Pct:0, top10Pct:0 };
  }
}

/* ====================== VIRTUAL helpers (open/close/track) ====================== */
function feeBuy()  { return (CFG.PRIORITY_FEE_BUY ?? CFG.PRIORITY_FEE_SOL); }
function feeSell() { return (CFG.PRIORITY_FEE_SELL ?? CFG.PRIORITY_FEE_SOL); }

function virtOpen(mint, { inSol, expOutTokens, entryRatio, poolAddrs }) {
  const now = Date.now();
  VIRT.open.set(mint, { ts: now, inSol, expOutTokens, entryRatio, poolAddrs, note: CFG.VIRTUAL_NOTE });
  VIRT.trackers.delete(mint);
  csv({ event:'vbuy', side:'VBUY', sol:inSol, token:mint, extra:`entryRatio=${fmt(entryRatio,6)} tokens=${fmt(expOutTokens,4)}` });
  info(`[VIRTUAL] 📥 OPEN ${mint} inSol=${fmt(inSol,4)} tokens≈${fmt(expOutTokens,4)} r=${fmt(entryRatio,6)} ${CFG.VIRTUAL_NOTE?`(${CFG.VIRTUAL_NOTE})`:''}`);

  if (CFG.VIRTUAL_VERBOSE) startVirtualTracker(mint);
}
function virtClose(mint, { outSol, reason='virtual-exit' } = {}) {
  const pos = VIRT.open.get(mint);
  if (!pos) { warn(`[VIRTUAL] close skip: no open pos for ${mint}`); return null; }
  const dt = Date.now() - pos.ts;
  const pnlSol = Number(outSol) - Number(pos.inSol);

  // stop tracker
  const tr = VIRT.trackers.get(mint);
  if (tr?.timer) try { clearInterval(tr.timer); } catch {}
  VIRT.trackers.delete(mint);

  VIRT.open.delete(mint);
  const rec = { mint, openedAt: pos.ts, msHeld: dt, inSol: pos.inSol, outSol, pnlSol, reason, note: pos.note };
  VIRT.history.unshift(rec);
  csv({ event:'vsell', side:'VSELL', sol:outSol, token:mint, extra:`pnl=${fmt(pnlSol,6)} heldMs=${dt} reason=${reason}` });

  const pnlPct = pos.inSol > 0 ? (pnlSol / pos.inSol) * 100 : 0;
  info(`[VIRTUAL] 📤 CLOSE ${mint} outSol=${fmt(outSol,4)} pnl=${fmt(pnlSol,6)} (${pnlPct.toFixed(2)}%) in ${dt}ms ← ${reason}`);
  return rec;
}
async function _virtQuoteSellSol(mint) {
  try {
    const pos = VIRT.open.get(mint);
    if (!pos) return null;
    const amountIn = pos.expOutTokens; // quantité virtuelle détenue
    const route = await gmgnGetRoute({
      tokenIn: mint, tokenOut: CFG.BASE_SOL_MINT, inLamports: amountIn,
      fromAddress: WALLET_PK, slippagePct: CFG.MAX_SLIPPAGE,
      feeSol: feeSell(), isAntiMev: CFG.ANTI_MEV,
    });
    const outSol = Number(route?.quote?.outAmount || 0);
    return { outSol, route };
  } catch (e) {
    return { outSol: 0, err: String(e?.message || e) };
  }
}
function startVirtualTracker(mint) {
  const pos = VIRT.open.get(mint);
  if (!pos) return;
  const interval = Math.max(200, CFG.VIRTUAL_MTM_MS);
  const tr = { timer: null, lastOutSol: -1 };
  VIRT.trackers.set(mint, tr);

  tr.timer = setInterval(async () => {
    const now = Date.now();
    const heldMs = now - pos.ts;
    const q = await _virtQuoteSellSol(mint);
    if (!q) return;
    const outSol = Number(q.outSol || 0);

    let shouldLog = false;
    if (tr.lastOutSol <= 0) shouldLog = true;
    else {
      const changePct = (Math.abs(outSol - tr.lastOutSol) / Math.max(1e-9, tr.lastOutSol)) * 100;
      if (changePct >= CFG.VIRTUAL_MTM_CHANGE_PCT) shouldLog = true;
      if (heldMs % 5000 < interval) shouldLog = true; // heartbeat 5s
    }

    if (shouldLog) {
      tr.lastOutSol = outSol;
      const pnlSol = outSol - pos.inSol;
      const pnlPct = pos.inSol > 0 ? (pnlSol / pos.inSol) * 100 : 0;
      const secs = (heldMs/1000).toFixed(1);
      info(`[VIRTUAL][MTM] ${mint} t=${secs}s val=${fmt(outSol,4)} pnl=${fmt(pnlSol,6)} (${pnlPct.toFixed(2)}%)`);
    }
  }, interval);
}

/* ====================== BUY / SELL ====================== */
async function buyViaGMGN(mint, { startTs=Date.now() } = {}) {
  const inLamports = Math.floor(CFG.TRADE_SIZE_SOL * LAMPORTS_PER_SOL);
  const route = await gmgnGetRoute({
    tokenIn: CFG.BASE_SOL_MINT, tokenOut: mint, inLamports,
    fromAddress: WALLET_PK, slippagePct: CFG.MAX_SLIPPAGE,
    feeSol: feeBuy(), isAntiMev: CFG.ANTI_MEV,
  });

  const early = (Date.now() - startTs) <= CFG.EARLY_RELAX_GUARDS_MS;
  assertRouteGuards(route, { early });

  const rawBase64 = route.raw_tx?.swapTransaction;

  // Pré-submit stability
  const stable = await preSubmitLiquidityStabilityCheck(rawBase64);
  if (!stable) throw new Error('pre-submit liquidity stability check failed');

  // Comptes du pool + subscriptions
  let poolAddrs = [];
  try {
    const poolTok = await extractPoolTokenAccountsFromRawBase64(rawBase64);
    poolAddrs = poolTok.map(x => x.addr);
    if (poolAddrs.length && globalThis.wsInstance) {
      globalThis.wsInstance.subscribeAccounts(poolAddrs);      // logs
      for (const a of poolAddrs) {
        poolAddrToMint.set(a, mint);
        globalThis.wsInstance.accountSubscribe(a);            // accounts (balances)
      }
      mintToPoolAddrs.set(mint, poolAddrs.slice());
    }
  } catch (e) { dbg('subscribe pool accounts err', e.message); }

  // Holders guard AVANT BUY
  if (CFG.HOLDER_CHECK_PREBUY) {
    const holders = await getLargestHoldersMetrics(mint, { excludeAddrs: poolAddrs });
    if (holders.ok) {
      info(`[HOLDERS pre] top1=${holders.top1Pct.toFixed(1)}% | top10=${holders.top10Pct.toFixed(1)}%`);
      if (holders.top1Pct >= CFG.TOP1_HOLDER_MAX_PCT || holders.top10Pct >= CFG.TOP10_HOLDER_MAX_PCT) {
        throw new Error(`holders-guard: concentration too high (top1=${holders.top1Pct.toFixed(1)}% / top10=${holders.top10Pct.toFixed(1)}%)`);
      }
    }
  }

  const entryRatio = ratioOutOverIn(route.quote) || 0;

  if (CFG.VIRTUAL_MODE) {
    // ===== MODE VIRTUEL =====
    const inSol = CFG.TRADE_SIZE_SOL;
    const expOutTokens = Number(route?.quote?.outAmount || 0);
    virtOpen(mint, { inSol, expOutTokens, entryRatio, poolAddrs });

    // Probes / gardes identiques
    postBuySellProbe(mint, entryRatio).catch(()=>{});
    rugGuardAfterBuy({ mint, entryRatio }).catch(()=>{});

    if (CFG.HOLDER_CHECK_POSTBUY_MS > 0) {
      setTimeout(async () => {
        try {
          const holders = await getLargestHoldersMetrics(mint, { excludeAddrs: poolAddrs });
          if (holders.ok) {
            info(`[HOLDERS post] top1=${holders.top1Pct.toFixed(1)}% | top10=${holders.top10Pct.toFixed(1)}%`);
            if (holders.top1Pct >= CFG.TOP1_HOLDER_MAX_PCT || holders.top10Pct >= CFG.TOP10_HOLDER_MAX_PCT) {
              warn('[HOLDERS post] concentration too high → VIRTUAL SELL NOW');
              await sellAllViaGMGN(mint, { reason: 'holders-concentration' });
            }
          }
        } catch (e) { warn('holders post-check error:', e.message); }
      }, CFG.HOLDER_CHECK_POSTBUY_MS);
    }

    if (CFG.EXIT_TIMEOUT_MS > 0) {
      setTimeout(async () => {
        info(`⏳ [VIRTUAL] Timeout ${CFG.EXIT_TIMEOUT_MS}ms → VSELL ${mint}`);
        await sellAllViaGMGN(mint, { reason: 'timeout' });
      }, CFG.EXIT_TIMEOUT_MS);
    }

    // Pas de nettoyage agressif en virtuel (on garde l’écoute pendant POST_SUBSCRIBE_MONITOR_MS)
    setTimeout(() => {
      try {
        if (globalThis.wsInstance?.unsubscribeAccount) {
          for (const a of poolAddrs) globalThis.wsInstance.unsubscribeAccount(a);
        }
      } catch {}
    }, CFG.POST_SUBSCRIBE_MONITOR_MS);

    return { route, hash: 'virtual' };
  }

  // ===== MODE REEL =====
  const unsigned = Buffer.from(rawBase64, 'base64');
  const tx = VersionedTransaction.deserialize(unsigned);
  tx.sign([wallet]);
  const signed = Buffer.from(tx.serialize()).toString('base64');

  const submit = await gmgnSubmitSignedTx(signed, CFG.ANTI_MEV);
  info(`[BUY] …pending hash=${submit.hash} r=${fmt(entryRatio,6)}`);
  csv({ event:'enter', side:'BUY', sol:CFG.TRADE_SIZE_SOL, token:mint, extra:`hash=${submit.hash}` });

  // Nettoyage subscriptions après fenêtre d’écoute
  if (poolAddrs.length) {
    setTimeout(() => {
      try {
        if (globalThis.wsInstance?.unsubscribeAccount) {
          for (const a of poolAddrs) globalThis.wsInstance.unsubscribeAccount(a);
        }
      } catch {}
    }, CFG.POST_SUBSCRIBE_MONITOR_MS);
  }

  // Status log
  (async () => {
    try {
      const maxMs = 8000, t0 = Date.now();
      while (Date.now() - t0 < maxMs) {
        const st = await gmgnCheckStatus({ hash: submit.hash, lastValidBlockHeight: route.raw_tx.lastValidBlockHeight });
        if (st.success) { info('[BUY] ✅ confirmed'); return; }
        if (st.expired || st.failed) { warn('[BUY] ❌ not confirmed (expired/failed)'); return; }
        await sleep(350);
      }
      warn('BUY status timeout');
    } catch(e) { warn('status error:', e.message); }
  })();

  // Probes / gardes en réel
  postBuySellProbe(mint, entryRatio).catch(()=>{});
  rugGuardAfterBuy({ mint, entryRatio }).catch(()=>{});
  if (CFG.HOLDER_CHECK_POSTBUY_MS > 0) {
    setTimeout(async () => {
      try {
        const holders = await getLargestHoldersMetrics(mint, { excludeAddrs: poolAddrs });
        if (holders.ok) {
          info(`[HOLDERS post] top1=${holders.top1Pct.toFixed(1)}% | top10=${holders.top10Pct.toFixed(1)}%`);
          if (holders.top1Pct >= CFG.TOP1_HOLDER_MAX_PCT || holders.top10Pct >= CFG.TOP10_HOLDER_MAX_PCT) {
            warn('[HOLDERS post] concentration too high → SELL NOW');
            await sellAllViaGMGN(mint, { reason: 'holders-concentration' });
          }
        }
      } catch (e) { warn('holders post-check error:', e.message); }
    }, CFG.HOLDER_CHECK_POSTBUY_MS);
  }

  if (CFG.EXIT_TIMEOUT_MS > 0) {
    setTimeout(async () => {
      info(`⏳ Timeout ${CFG.EXIT_TIMEOUT_MS}ms → SELL ALL ${mint}`);
      await sellAllViaGMGN(mint, { reason: 'timeout' });
    }, CFG.EXIT_TIMEOUT_MS);
  }

  return { route, hash: submit.hash };
}

async function getTokenBalanceLamports(owner, mint) {
  const ownerPk = new PublicKey(owner); const mintPk  = new PublicKey(mint);
  const resp = await connection.getTokenAccountsByOwner(ownerPk, { mint: mintPk }, 'confirmed');
  let total = 0n;
  for (const it of resp.value) {
    const acc = await connection.getParsedAccountInfo(it.pubkey, 'confirmed');
    const amt = BigInt(acc.value?.data?.parsed?.info?.tokenAmount?.amount || '0');
    total += amt;
  }
  return Number(total);
}

async function sellAllViaGMGN(mint, { virtual=false, reason='manual' } = {}) {
  if (CFG.VIRTUAL_MODE || virtual) {
    // ===== VENTE VIRTUELLE =====
    const amountIn = VIRT.open.get(mint)?.expOutTokens || await getTokenBalanceLamports(WALLET_PK, mint);
    if (amountIn <= 0) { warn('[VSELL] skip: no virtual amount'); return null; }

    try {
      const route = await gmgnGetRoute({
        tokenIn: mint, tokenOut: CFG.BASE_SOL_MINT, inLamports: amountIn,
        fromAddress: WALLET_PK, slippagePct: CFG.MAX_SLIPPAGE,
        feeSol: feeSell(), isAntiMev: CFG.ANTI_MEV,
      });
      const outSol = Number(route?.quote?.outAmount || 0);
      virtClose(mint, { outSol, reason });
      return { route, hash: 'virtual' };
    } catch (e) {
      warn('[VSELL] route error (virtual):', e.message);
      virtClose(mint, { outSol: 0, reason: `route-error:${e.message}` });
      return null;
    }
  }

  // ===== VENTE REELLE =====
  const amountIn = await getTokenBalanceLamports(WALLET_PK, mint);
  if (amountIn <= 0) { warn('[SELL] skip: no token balance'); return null; }

  const route = await gmgnGetRoute({
    tokenIn: mint, tokenOut: CFG.BASE_SOL_MINT, inLamports: amountIn,
    fromAddress: WALLET_PK, slippagePct: CFG.MAX_SLIPPAGE,
    feeSol: feeSell(), isAntiMev: CFG.ANTI_MEV,
  });

  const unsigned = Buffer.from(route.raw_tx.swapTransaction, 'base64');
  const tx = VersionedTransaction.deserialize(unsigned);
  tx.sign([wallet]);
  const signed = Buffer.from(tx.serialize()).toString('base64');

  const submit = await gmgnSubmitSignedTx(signed, CFG.ANTI_MEV);
  info(`[SELL] …pending hash=${submit.hash} ← ${reason}`);
  csv({ event:'exit', side:'SELL', sol:'', token:mint, extra:`hash=${submit.hash} reason=${reason}` });

  (async () => {
    try {
      const maxMs = 8000, t0 = Date.now();
      while (Date.now() - t0 < maxMs) {
        const st = await gmgnCheckStatus({ hash: submit.hash, lastValidBlockHeight: route.raw_tx.lastValidBlockHeight });
        if (st.success) { info('[SELL] ✅ confirmed'); return; }
        if (st.expired || st.failed) { warn('[SELL] ❌ not confirmed (expired/failed)'); return; }
        await sleep(350);
      }
      warn('SELL status timeout');
    } catch(e) { warn('SELL status error:', e.message); }
  })();

  return { route, hash: submit.hash };
}

/* ===== Post-buy SELL probe: toutes 200ms pendant 8s ===== */
async function postBuySellProbe(mint, entryRatio) {
  const t0 = Date.now(), maxMs = 8000;
  while (Date.now() - t0 < maxMs) {
    try {
      const bal = CFG.VIRTUAL_MODE
        ? (VIRT.open.get(mint)?.expOutTokens || 0)
        : await getTokenBalanceLamports(WALLET_PK, mint);
      if (bal <= 0) return;

      const route = await gmgnGetRoute({
        tokenIn: mint, tokenOut: CFG.BASE_SOL_MINT, inLamports: bal,
        fromAddress: WALLET_PK, slippagePct: CFG.MAX_SLIPPAGE,
        feeSol: feeSell(), isAntiMev: CFG.ANTI_MEV,
      });
      const r = ratioOutOverIn(route.quote);
      if (entryRatio > 0 && r < entryRatio * 0.85) {
        warn(`[PROBE] sell ratio collapsing (${r.toFixed(4)} < ${(entryRatio*0.85).toFixed(4)}) → SELL NOW`);
        await sellAllViaGMGN(mint, { reason: 'probe:ratio<85%' });
        return;
      }
    } catch (e) {
      const m = String(e.message||'').toLowerCase();
      if (m.includes('no route')) {
        warn('[PROBE] jupiter has no route (SELL) → SELL NOW');
        await sellAllViaGMGN(mint, { reason: 'probe:no-route' });
        return;
      }
    }
    await sleep(200);
  }
}

/* ====================== RUG GUARD prix ====================== */
async function rugGuardAfterBuy({ mint, entryRatio }) {
  if (CFG.RUG_GUARD_WINDOW_MS <= 0) return;

  const t0 = Date.now();
  const probeIn = Math.max(1, Math.floor(0.01 * LAMPORTS_PER_SOL));
  let failStreak = 0;

  while (Date.now() - t0 < CFG.RUG_GUARD_WINDOW_MS) {
    try {
      const probe = await gmgnGetRoute({
        tokenIn: CFG.BASE_SOL_MINT, tokenOut: mint, inLamports: probeIn,
        fromAddress: WALLET_PK, slippagePct: CFG.MAX_SLIPPAGE,
        feeSol: feeBuy(), isAntiMev: CFG.ANTI_MEV,
      });
      failStreak = 0;

      const imp = Number(probe.quote?.priceImpactPct || 0) * 100;
      const ratio = ratioOutOverIn(probe.quote);

      if (entryRatio > 0) {
        const dropPct = (1 - (ratio / entryRatio)) * 100;
        if (dropPct >= CFG.RUG_DROP_PCT) {
          warn(`[RUG] drop ${dropPct.toFixed(1)}% ≥ ${CFG.RUG_DROP_PCT}% → SELL NOW`);
          await sellAllViaGMGN(mint, { reason: 'rug-guard:price-drop' });
          return;
        }
      }
      if (imp > Math.max(45, CFG.MAX_PRICE_IMPACT_PCT + 20)) {
        warn(`[RUG] impact ${imp.toFixed(1)}% → SELL NOW`);
        await sellAllViaGMGN(mint, { reason: 'rug-guard:impact' });
        return;
      }
    } catch (e) {
      failStreak++;
      warn('[RUG] probe error:', e.message);
      if (failStreak >= 3) {
        warn('[RUG] probes repeatedly failing → SELL NOW');
        await sellAllViaGMGN(mint, { reason: 'rug-guard:probe-fail' });
        return;
      }
    }
    await sleep(220);
  }
}

/* ====================== Handler (depuis tx confirmé/processed) ====================== */
const seenMint = new Map(); // anti-refire 30s

async function handleFromTx(sig, tx) {
  const startTs = Date.now();
  const mint = extractMintFromTx(tx);
  if (!mint) { dbg(`[SKIP] no mint extracted sig=${sig}`); return; }

  const added = estimateSolAddedFromTx(tx);
  const age = poolAgeFromTxMs(tx);
  const progs = collectProgramsFromTx(tx);
  const src = progs.includes('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA') ? 'PUMP_AMM' : 'unknown';
  const minSol = (src === 'PUMP_AMM') ? CFG.PUMP_TRIGGER_MIN_SOL : CFG.TRIGGER_MIN_SOL;

  if (age > CFG.MAX_POOL_AGE_MS) { dbg(`[SKIP] old pool (${age}ms > ${CFG.MAX_POOL_AGE_MS}) mint=${mint} sig=${sig}`); return; }
  if (added < minSol) { dbg(`[SKIP] below-threshold (${fmt(added)} < ${minSol}) mint=${mint} sig=${sig}`); return; }

  info(`🚀 token=${mint} | src=${src} | added≈${fmt(added)} SOL | age=${age}ms sig=${sig}`);

  const now = Date.now();
  if (seenMint.get(mint) && now - seenMint.get(mint) < 30000) { dbg(`[SKIP] cooldown 30s mint=${mint} sig=${sig}`); return; }
  seenMint.set(mint, now);

  try {
    const { route } = await buyViaGMGN(mint, { startTs });
    const entryRatio = ratioOutOverIn(route.quote) || 0;
    // rugGuardAfterBuy déjà appelé dans buyViaGMGN
  } catch (e) { err('Buy failed:', e.message); }
}

/* ====================== Helius WS client ====================== */
function sanitizedProgramIds(list) {
  const out = [];
  for (const raw of list) {
    const id = (raw || '').trim();
    if (!id) continue;
    if (!PK_RE.test(id)) { warn(`Invalid AMM program id: "${raw}" → ignored`); continue; }
    try { new PublicKey(id); out.push(id); } catch (e) { warn(`Invalid AMM program id: "${raw}" → ${e.message}`); }
  }
  return out;
}
const LOG_RE = new RegExp(CFG.POOL_LOG_PATTERNS, 'i');

class HeliusWS {
  constructor(url) {
    this.url = url;
    this.ws = null;
    this.subs = new Map();              // key -> payload
    this.pinger = null;
    this.reconnTimer = null;
    this.nextId = 1;

    this.reqIdToSig = new Map();        // request id -> signature (signatureSubscribe)
    this.subIdToSig = new Map();        // subId -> signature

    this.reqIdToAcct = new Map();       // request id -> account pubkey (accountSubscribe)
    this.subIdToAcct = new Map();       // subId -> account pubkey
  }
  start() { this._connect(); }
  stop() { try { this.ws?.close(); } catch{} clearInterval(this.pinger); clearTimeout(this.reconnTimer); }

  _connect() {
    this.ws = new WebSocket(this.url);
    this.ws.on('open', () => {
      info('WS connected:', this.url);
      for (const [, payload] of this.subs) this._send(payload);
      clearInterval(this.pinger);
      this.pinger = setInterval(() => { try { this.ws?.ping?.(); } catch{} }, 45000);
    });
    this.ws.on('message', (d) => this._onMessage(d));
    this.ws.on('close', () => {
      warn('WS closed — reconnect in 2s');
      clearInterval(this.pinger);
      clearTimeout(this.reconnTimer);
      this.reconnTimer = setTimeout(() => this._connect(), 2000);
    });
    this.ws.on('error', (e) => errOnce('ws', 'WS error:', e.message));
  }
  _send(obj) {
    try { this.ws?.send(JSON.stringify(obj)); } catch (e) { errOnce('wsSend', e.message); }
  }

  logsSubscribeMentions(pubkey, commitment = 'processed') {
    const id = this.nextId++;
    const payload = { jsonrpc: '2.0', id, method: 'logsSubscribe', params: [{ mentions: [pubkey] }, { commitment }] };
    this.subs.set(`logs:${pubkey}`, payload);
    this._send(payload);
    info(`WS logs listener started (mentions): ${pubkey}`);
  }
  signatureSubscribe(sig, commitment = 'processed') {
    const id = this.nextId++;
    const payload = { jsonrpc: '2.0', id, method: 'signatureSubscribe', params: [sig, { commitment }] };
    this.reqIdToSig.set(id, sig);
    this._send(payload);
  }

  // Subscribe/unsubscribe dynamiques
  subscribeAccounts(accounts) {
    for (const a of accounts) {
      try {
        if (!PK_RE.test(a)) continue;
        const key = `logs:${a}`;
        if (!this.subs.has(key)) {
          const id = this.nextId++;
          const payload = { jsonrpc: '2.0', id, method: 'logsSubscribe', params: [{ mentions: [a] }, { commitment: 'processed' }] };
          this.subs.set(key, payload);
          this._send(payload);
          info(`WS pool-account (logs) listener: ${a}`);
        }
      } catch (e) { dbg('subscribeAccounts err', e.message); }
    }
  }
  accountSubscribe(pubkey) {
    try {
      if (!PK_RE.test(pubkey)) return;
      const key = `acct:${pubkey}`;
      if (this.subs.has(key)) return; // already
      const id = this.nextId++;
      const payload = { jsonrpc: '2.0', id, method: 'accountSubscribe', params: [pubkey, { commitment: 'processed', encoding: 'jsonParsed' }] };
      this.subs.set(key, payload);
      this.reqIdToAcct.set(id, pubkey);
      this._send(payload);
      info(`WS account listener started: ${pubkey}`);
    } catch (e) { dbg('accountSubscribe err', e.message); }
  }
  unsubscribeAccount(a) {
    const keyL = `logs:${a}`;
    if (this.subs.has(keyL)) this.subs.delete(keyL);
    const keyA = `acct:${a}`;
    if (this.subs.has(keyA)) this.subs.delete(keyA);
  }

  async _onMessage(data) {
    let msg = null;
    try { msg = JSON.parse(String(data)); } catch { return; }

    // Réponses d'abonnements → subId
    if (msg?.id && msg?.result && typeof msg.result === 'number') {
      const subId = msg.result;
      const sig = this.reqIdToSig.get(msg.id);
      if (sig) { this.subIdToSig.set(subId, sig); this.reqIdToSig.delete(msg.id); return; }
      const acct = this.reqIdToAcct.get(msg.id);
      if (acct) { this.subIdToAcct.set(subId, acct); this.reqIdToAcct.delete(msg.id); return; }
    }

    // logsNotification
    if (msg?.method === 'logsNotification') {
      const res = msg?.params?.result?.value;
      const sig = res?.signature;
      const logs = res?.logs || [];
      if (!sig || !Array.isArray(logs) || logs.length === 0) return;

      // Déclencheur initial
      if (CFG.WS_REQUIRE_PATTERN) {
        const hit = logs.some(line => LOG_RE.test(line));
        if (hit) this.signatureSubscribe(sig, CFG.SIGNATURE_COMMITMENT || 'processed');
      } else {
        this.signatureSubscribe(sig, CFG.SIGNATURE_COMMITMENT || 'processed');
      }

      // withdraw-like keywords
      const joined = logs.join(' ').toLowerCase();
      const suspiciousKw = ['withdraw', 'remove_liquidity', 'removeliquidity', 'withdrawliquidity', 'closeposition', 'decrease_liquidity', 'burn', 'burned', 'withdraw_reserve'];
      const hitKw = suspiciousKw.some(k => joined.includes(k));
      if (hitKw) {
        for (const [addr, mint] of poolAddrToMint.entries()) {
          if (joined.includes(addr.toLowerCase())) {
            warn(`[WS] ⚠️ withdraw-like log on ${addr} → SELL ${mint}`);
            (async () => { try { await sellAllViaGMGN(mint, { reason: 'withdraw-log' }); } catch(e) { warn('post-withdraw sell err', e.message); } })();
          }
        }
      }
      return;
    }

    // accountNotification (baisse de réserves)
    if (msg?.method === 'accountNotification') {
      const subId = msg?.params?.subscription;
      const pubkey = this.subIdToAcct.get(subId);
      const dataV = msg?.params?.result?.value?.data;
      const parsed = dataV?.parsed;
      const uiAmount = Number(parsed?.info?.tokenAmount?.uiAmount || 0);
      if (!pubkey || !Number.isFinite(uiAmount)) return;

      if (!globalThis.__acctPrevBal) globalThis.__acctPrevBal = new Map();
      const prev = globalThis.__acctPrevBal.get(pubkey) ?? uiAmount;
      globalThis.__acctPrevBal.set(pubkey, uiAmount);

      if (prev > 0) {
        const dropPct = (1 - (uiAmount / prev)) * 100;
        if (dropPct >= CFG.ACCT_DROP_PCT_TRIGGER) {
          const mint = poolAddrToMint.get(pubkey);
          if (mint) {
            warn(`[WS] 🔻 reserve drop ${dropPct.toFixed(1)}% on ${pubkey} ≥ ${CFG.ACCT_DROP_PCT_TRIGGER}% → SELL ${mint}`);
            (async () => { try { await sellAllViaGMGN(mint, { reason: `reserve-drop-${dropPct.toFixed(1)}%` }); } catch(e) { warn('sell on acctDrop err', e.message); } })();
          }
        }
      }
      return;
    }

    // signatureNotification
    if (msg?.method === 'signatureNotification') {
      const subId = msg?.params?.subscription;
      const sig = this.subIdToSig.get(subId);
      const errV = msg?.params?.result?.value?.err ?? msg?.params?.result?.err ?? null;
      if (!sig) { dbg('[WS] signatureNotification sans sig'); return; }
      this.subIdToSig.delete(subId);
      if (errV) { dbg(`[WS] signature FAILED sig=${sig}`); return; }

      const tx = await getTransactionWithFallback(sig);
      if (!tx) { dbg(`[WS] getTransaction miss (confirmed) sig=${sig}`); return; }
      await handleFromTx(sig, tx);
      return;
    }
  }
}

/* ====================== Webhook + Health + Virtual endpoints ====================== */
const app = express();
app.use(bodyParser.json({ limit: '20mb' }));

app.post('/helius-webhook', async (req, res) => {
  try {
    if (req.body && (req.body.signature || req.body.txSig || typeof req.body === 'string')) {
      const sig = req.body.signature || req.body.txSig || (typeof req.body === 'string' ? req.body : null);
      info('RAW webhook sig:', sig);
      const tx = await getTransactionWithFallback(sig);
      if (!tx) return res.status(200).send({ ok:true, note:'tx-not-found', sig });
      await handleFromTx(sig, tx);
      return res.status(200).send({ ok:true, processed:true, sig });
    }
    const payload = Array.isArray(req.body) ? req.body[0] : req.body;
    const sig = payload?.signature || payload?.transaction?.signatures?.[0];
    if (!sig) return res.status(200).send({ ok:true, note:'no-signature' });
    const tx = await getTransactionWithFallback(sig);
    if (!tx) return res.status(200).send({ ok:true, note:'tx-not-found', sig });
    await handleFromTx(sig, tx);
    return res.status(200).send({ ok:true, processed:true, sig });
  } catch (e) {
    err('webhook error:', e.message || e);
    return res.status(500).send({ ok:false, error: e.message || String(e) });
  }
});

app.get('/health', (_req, res) => res.send({
  ok: true,
  wallet: WALLET_PK,
  cfg: {
    maxPoolAgeMs: CFG.MAX_POOL_AGE_MS,
    triggerMinSol: CFG.TRIGGER_MIN_SOL,
    pumpTriggerMinSol: CFG.PUMP_TRIGGER_MIN_SOL,
    tradeSizeSOL: CFG.TRADE_SIZE_SOL,
    maxSlippage: CFG.MAX_SLIPPAGE,
    priorityFees: { buy: feeBuy(), sell: feeSell() },
    antiMEV: CFG.ANTI_MEV,
    exitTimeoutMs: CFG.EXIT_TIMEOUT_MS,
    ammPrograms: CFG.AMM_PROGRAM_IDS,
    rpc: { rps: CFG.RPC_RPS, conc: CFG.RPC_MAX_CONCURRENCY, backoffMs: CFG.RPC_BACKOFF_MS, backoffMax: CFG.RPC_BACKOFF_MAX_MS },
    heliusWs: !!CFG.HELIUS_WS_URL,
    patterns: CFG.POOL_LOG_PATTERNS,
    commitments: { sig: CFG.SIGNATURE_COMMITMENT, tx: CFG.TX_FETCH_COMMITMENT },
    earlyProbe: { ms: CFG.EARLY_ROUTE_PROBE_MS, interval: CFG.EARLY_ROUTE_PROBE_INTERVAL_MS, relaxMs: CFG.EARLY_RELAX_GUARDS_MS },
    antiWithdraw: {
      preMs: CFG.PRE_SUBMIT_STABILITY_MS,
      prePolls: CFG.PRE_SUBMIT_POLLS,
      preDropPct: CFG.PRE_SUBMIT_DROP_PCT,
      postListenMs: CFG.POST_SUBSCRIBE_MONITOR_MS,
      poolTokMin: CFG.POOL_TOKEN_MIN_BALANCE,
      acctDropTrigger: CFG.ACCT_DROP_PCT_TRIGGER,
    },
    holders: {
      preBuy: CFG.HOLDER_CHECK_PREBUY,
      postMs: CFG.HOLDER_CHECK_POSTBUY_MS,
      top1Max: CFG.TOP1_HOLDER_MAX_PCT,
      top10Max: CFG.TOP10_HOLDER_MAX_PCT,
    },
    virtual: {
      enabled: CFG.VIRTUAL_MODE,
      verbose: CFG.VIRTUAL_VERBOSE,
      mtmMs: CFG.VIRTUAL_MTM_MS,
      mtmChangePct: CFG.VIRTUAL_MTM_CHANGE_PCT,
      note: CFG.VIRTUAL_NOTE,
    },
  },
}));

app.get('/virtual-positions', (_req, res) => {
  res.send({
    virtual: CFG.VIRTUAL_MODE,
    open: [...VIRT.open.entries()].map(([mint, v]) => ({ mint, ...v })),
    history: VIRT.history.slice(0, 50),
  });
});

/* ====================== Start ====================== */
app.listen(CFG.PORT, () => {
  info(`GMGN sniping listener on :${CFG.PORT} (LOG_LEVEL=${CFG.LOG_LEVEL})`);

  const ws = new HeliusWS(CFG.HELIUS_WS_URL);
  globalThis.wsInstance = ws;

  const programs = sanitizedProgramIds(CFG.AMM_PROGRAM_IDS);
  if (programs.length === 0) {
    warn('AMM_PROGRAM_IDS vide → écoute Pump AMM uniquement par défaut.');
    ws.logsSubscribeMentions('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA', CFG.SIGNATURE_COMMITMENT || 'processed');
  } else {
    for (const id of programs) ws.logsSubscribeMentions(id, CFG.SIGNATURE_COMMITMENT || 'processed');
  }
  ws.start();
});
