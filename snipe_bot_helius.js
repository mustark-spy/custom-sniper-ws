/**
 * snipe_bot_ws_raw_gmgn.js — v4 (WS-first, HTTP minimal & maîtrisé)
 *
 * - Détection ultra-rapide: Helius WebSocket logsSubscribe(mentions) sur AMM_PROGRAM_IDS (CSV)
 * - Anti-spam RPC: file HTTP (RPS plafonné + concurrence limitée + backoff 429 + retries confirmés)
 * - Garde-fous GMGN, mini Rug-guard, sortie au timeout, CSV
 * - Webhook raw & enhanced conservés (optionnels)
 *
 * ENV minimales:
 *   HELIUS_WS_URL=wss://mainnet.helius-rpc.com/?api-key=XXXX
 *   RPC_URL=https://mainnet.helius-rpc.com/?api-key=XXXX   (même clé OK)
 *   AMM_PROGRAM_IDS=pAMMBay...,CLMM...,675kPX...,whirl...,CAMMC...
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

  // RPC HTTP (Helius conseillé) — UNIQUEMENT pour lire la transaction APRES notif WS
  RPC_URL: process.env.RPC_URL || 'https://api.mainnet-beta.solana.com',

  // WebSocket Helius
  HELIUS_WS_URL: process.env.HELIUS_WS_URL || '',

  // Filtres d'entrée
  MAX_POOL_AGE_MS: Number(process.env.MAX_POOL_AGE_MS || 3000),
  TRIGGER_MIN_SOL: Number(process.env.TRIGGER_MIN_SOL || 200),
  PUMP_TRIGGER_MIN_SOL: Number(process.env.PUMP_TRIGGER_MIN_SOL || 350),

  // Trade
  TRADE_SIZE_SOL: Number(process.env.TRADE_SIZE_SOL || 0.20),
  MAX_SLIPPAGE: Number(process.env.MAX_SLIPPAGE || 0.30), // en %
  PRIORITY_FEE_SOL: Number(process.env.PRIORITY_FEE_SOL || 0.006),
  ANTI_MEV: ['1','true','yes'].includes(String(process.env.ANTI_MEV || '').toLowerCase()),

  // Sortie
  EXIT_TIMEOUT_MS: Number(process.env.EXIT_TIMEOUT_MS || 15000),

  // Garde-fous route (GMGN)
  MAX_PRICE_IMPACT_PCT: Number(process.env.MAX_PRICE_IMPACT_PCT || 22),
  MIN_OTHER_OVER_OUT: Number(process.env.MIN_OTHER_OVER_OUT || 0.965),
  MIN_OUT_PER_SOL: Number(process.env.MIN_OUT_PER_SOL || 0),

  // Rug-guard
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

  // AMM program filters (CSV)
  AMM_PROGRAM_IDS: (process.env.AMM_PROGRAM_IDS || '')
    .split(',').map(s => s.trim()).filter(Boolean),

  // File RPC HTTP (maîtrise du débit)
  RPC_RPS: Number(process.env.RPC_RPS || 6),
  RPC_MAX_CONCURRENCY: Number(process.env.RPC_MAX_CONCURRENCY || 2),
  RPC_BACKOFF_MS: Number(process.env.RPC_BACKOFF_MS || 700),

  // Retrys (post logs) pour laisser la TX passer en confirmed
  // => court & agressif pour rester dans la fenêtre 2–4s
  TX_FETCH_RETRIES: Number(process.env.TX_FETCH_RETRIES || 4),
  TX_FETCH_DELAY_MS: Number(process.env.TX_FETCH_DELAY_MS || 140),
};

const dbg  = (...a) => { if (CFG.LOG_LEVEL === 'debug') console.log(...a); };
const info = (...a) => console.log(...a);
const warn = (...a) => console.warn(...a);
const err  = (...a) => console.error(...a);

if (!CFG.WALLET_SECRET_KEY) { err('❌ WALLET_SECRET_KEY manquant'); process.exit(1); }
if (!CFG.HELIUS_WS_URL)    { err('❌ HELIUS_WS_URL manquant');    process.exit(1); }

if (!fs.existsSync(CFG.CSV_FILE)) fs.writeFileSync(CFG.CSV_FILE, 'time,event,side,sol,token,extra\n');
const csv = (r) => {
  const line = `${new Date().toISOString()},${r.event},${r.side||''},${r.sol||''},${r.token||''},${r.extra||''}\n`;
  fs.appendFileSync(CFG.CSV_FILE, line);
};

/* ====================== Setup ====================== */
const connection = new Connection(CFG.RPC_URL, { commitment: 'processed' });
const wallet = Keypair.fromSecretKey(bs58.decode(CFG.WALLET_SECRET_KEY));
const WALLET_PK = wallet.publicKey.toBase58();

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const fmt = (n, d=6) => (typeof n === 'number' ? Number(n).toFixed(d) : n);
const PK_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/* ====================== Anti-spam logs ====================== */
const lastErr = new Map();
function errOnce(key, ...msg) {
  const now = Date.now();
  const last = lastErr.get(key) || 0;
  if (now - last > 1500) {
    lastErr.set(key, now);
    err(...msg);
  } else {
    dbg(...msg);
  }
}

/* ====================== File HTTP (RPS + Concurrency + Backoff 429) ====================== */
class HttpBucket {
  constructor({ rps, concurrency, backoffMs }) {
    this.interval = Math.max(1000 / Math.max(1, rps), 50);
    this.maxConc = Math.max(1, concurrency);
    this.baseBackoff = Math.max(100, backoffMs);
    this.dynamicBackoff = 0; // backoff adaptatif
    this.queue = [];
    this.running = 0;
    setInterval(() => this._drain(), this.interval);
  }
  push(fn, tag='') {
    return new Promise((resolve) => {
      this.queue.push({ fn, resolve, tag });
      this._drain();
    });
  }
  async _drain() {
    while (this.running < this.maxConc && this.queue.length) {
      const task = this.queue.shift();
      this.running++;
      (async () => {
        try {
          // backoff adaptatif si nécessaire
          if (this.dynamicBackoff > 0) await sleep(this.dynamicBackoff);
          const out = await task.fn();
          task.resolve(out);
        } catch (e) {
          const m = String(e?.message||'');
          if (m.includes('429') || m.includes('rate limited')) {
            // augmente le backoff adaptatif (cap à 3s)
            this.dynamicBackoff = Math.min(this.dynamicBackoff + this.baseBackoff, 3000);
            errOnce('429', `429 rate-limited, retry in ${this.dynamicBackoff}ms`);
            await sleep(this.dynamicBackoff);
          } else {
            // baisse progressivement
            this.dynamicBackoff = Math.max(0, Math.floor(this.dynamicBackoff * 0.6));
          }
          task.resolve(null);
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
});

async function getTransactionCautious(sig, attempts=CFG.TX_FETCH_RETRIES, delay=CFG.TX_FETCH_DELAY_MS) {
  for (let i=0;i<attempts;i++) {
    const res = await httpBucket.push(
      () => connection.getTransaction(sig, { commitment:'confirmed', maxSupportedTransactionVersion: 0 }),
      'getTx:confirmed'
    );
    if (res) return res;
    await sleep(delay);
  }
  return null;
}

/* ====================== Helpers extraction ====================== */
function tsFromTxMs(tx) { const t = tx?.blockTime; return (t ? Number(t)*1000 : null); }
function poolAgeFromTxMs(tx) { const t = tsFromTxMs(tx); return (t==null) ? null : (Date.now() - t); }

function estimateSolAddedFromTx(tx) {
  const pre = tx?.meta?.preBalances || [];
  const post = tx?.meta?.postBalances || [];
  if (!pre.length || !post.length) return 0;
  let delta = 0;
  for (let i=0;i<post.length;i++) {
    const d = (post[i] - (pre[i]||0));
    if (d > 0) delta += d / LAMPORTS_PER_SOL;
  }
  return delta;
}

function extractMintFromTx(tx) {
  const pre = tx?.meta?.preTokenBalances || [];
  const post = tx?.meta?.postTokenBalances || [];
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

/* ====================== GMGN helpers & guards ====================== */
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

  const url = `${CFG.GMGN_HOST}/defi/router/v1/sol/tx/get_swap_route?${params.toString()}`;
  const res = await fetch(url);
  const data = await res.json().catch(()=> ({}));
  if (!res.ok || !data || data.code !== 0 || !data.data?.raw_tx?.swapTransaction) {
    throw new Error(`GMGN route invalid: ${JSON.stringify(data)} {status:${res.status}}`);
  }
  return data.data;
}
async function gmgnSubmitSignedTx(base64Signed, isAntiMev=false) {
  const body = { chain: 'sol', signedTx: base64Signed };
  if (isAntiMev) body.isAntiMev = true;
  const res = await fetch(`${CFG.GMGN_HOST}/txproxy/v1/send_transaction`, {
    method: 'POST',
    headers: { 'content-type':'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(()=> ({}));
  if (!res.ok || data.code !== 0) {
    throw new Error(`GMGN submit error: ${JSON.stringify(data)} {status:${res.status}}`);
  }
  return data.data;
}
async function gmgnCheckStatus({ hash, lastValidBlockHeight }) {
  const url = `${CFG.GMGN_HOST}/defi/router/v1/sol/tx/get_transaction_status?hash=${hash}&last_valid_height=${lastValidBlockHeight}`;
  const res = await fetch(url);
  const data = await res.json().catch(()=> ({}));
  if (!res.ok || data.code !== 0) {
    throw new Error(`GMGN status error: ${JSON.stringify(data)} {status:${res.status}}`);
  }
  return data.data;
}

function ratioOutOverIn(quote) {
  const out = Number(quote?.outAmount || 0);
  const inp = Number(quote?.inAmount || 0);
  if (inp <= 0) return 0;
  return out / inp;
}

function assertRouteGuards(routeData) {
  const q = routeData.quote || {};
  const impactPct = Number(q?.priceImpactPct || 0) * 100;
  const out = Number(q?.outAmount || 0);
  const other = Number(q?.otherAmountThreshold || 0);

  if (impactPct > CFG.MAX_PRICE_IMPACT_PCT) {
    throw new Error(`route-guard: priceImpact ${impactPct.toFixed(2)}% > ${CFG.MAX_PRICE_IMPACT_PCT}%`);
  }
  if (out > 0) {
    const ratioOther = other / out;
    if (ratioOther < CFG.MIN_OTHER_OVER_OUT) {
      throw new Error(`route-guard: other/out ${(ratioOther).toFixed(3)} < ${CFG.MIN_OTHER_OVER_OUT}`);
    }
  }
  if (CFG.MIN_OUT_PER_SOL > 0) {
    const r = ratioOutOverIn(q);
    if (r < CFG.MIN_OUT_PER_SOL) {
      throw new Error(`route-guard: out/in ${r.toFixed(6)} < ${CFG.MIN_OUT_PER_SOL}`);
    }
  }
}

/* ====================== BUY / SELL ====================== */
async function buyViaGMGN(mint) {
  const inLamports = Math.floor(CFG.TRADE_SIZE_SOL * LAMPORTS_PER_SOL);
  const route = await gmgnGetRoute({
    tokenIn: CFG.BASE_SOL_MINT,
    tokenOut: mint,
    inLamports,
    fromAddress: WALLET_PK,
    slippagePct: CFG.MAX_SLIPPAGE,
    feeSol: CFG.PRIORITY_FEE_SOL,
    isAntiMev: CFG.ANTI_MEV,
  });

  assertRouteGuards(route);

  const unsigned = Buffer.from(route.raw_tx.swapTransaction, 'base64');
  const tx = VersionedTransaction.deserialize(unsigned);
  tx.sign([wallet]);
  const signed = Buffer.from(tx.serialize()).toString('base64');

  const submit = await gmgnSubmitSignedTx(signed, CFG.ANTI_MEV);

  info(`[BUY] …pending hash=${submit.hash} r=${fmt(ratioOutOverIn(route.quote),6)}`);
  csv({ event:'enter', side:'BUY', sol:CFG.TRADE_SIZE_SOL, token:mint, extra:`hash=${submit.hash}` });

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

  return { route, hash: submit.hash };
}

async function getTokenBalanceLamports(owner, mint) {
  const ownerPk = new PublicKey(owner);
  const mintPk  = new PublicKey(mint);
  const resp = await connection.getTokenAccountsByOwner(ownerPk, { mint: mintPk });
  let total = 0n;
  for (const it of resp.value) {
    const acc = await connection.getParsedAccountInfo(it.pubkey);
    const amt = BigInt(acc.value?.data?.parsed?.info?.tokenAmount?.amount || '0');
    total += amt;
  }
  return Number(total);
}

async function sellAllViaGMGN(mint) {
  const amountIn = await getTokenBalanceLamports(WALLET_PK, mint);
  if (amountIn <= 0) { warn('[SELL] skip: no token balance'); return null; }

  const route = await gmgnGetRoute({
    tokenIn: mint,
    tokenOut: CFG.BASE_SOL_MINT,
    inLamports: amountIn,
    fromAddress: WALLET_PK,
    slippagePct: CFG.MAX_SLIPPAGE,
    feeSol: CFG.PRIORITY_FEE_SOL,
    isAntiMev: CFG.ANTI_MEV,
  });

  const unsigned = Buffer.from(route.raw_tx.swapTransaction, 'base64');
  const tx = VersionedTransaction.deserialize(unsigned);
  tx.sign([wallet]);
  const signed = Buffer.from(tx.serialize()).toString('base64');

  const submit = await gmgnSubmitSignedTx(signed, CFG.ANTI_MEV);
  info(`[SELL] …pending hash=${submit.hash}`);
  csv({ event:'exit', side:'SELL', sol:'', token:mint, extra:`hash=${submit.hash}` });

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

/* ====================== RUG GUARD ====================== */
async function rugGuardAfterBuy({ mint, entryRatio }) {
  if (CFG.RUG_GUARD_WINDOW_MS <= 0) return;
  const t0 = Date.now();
  const probeIn = Math.max(1, Math.floor(0.01 * LAMPORTS_PER_SOL));
  while (Date.now() - t0 < CFG.RUG_GUARD_WINDOW_MS) {
    try {
      const probe = await gmgnGetRoute({
        tokenIn: CFG.BASE_SOL_MINT,
        tokenOut: mint,
        inLamports: probeIn,
        fromAddress: WALLET_PK,
        slippagePct: CFG.MAX_SLIPPAGE,
        feeSol: CFG.PRIORITY_FEE_SOL,
        isAntiMev: CFG.ANTI_MEV,
      });
      const imp = Number(probe.quote?.priceImpactPct || 0) * 100;
      const ratio = ratioOutOverIn(probe.quote);
      if (entryRatio > 0) {
        const dropPct = (1 - (ratio / entryRatio)) * 100;
        if (dropPct >= CFG.RUG_DROP_PCT) {
          warn(`[RUG] drop ${dropPct.toFixed(1)}% ≥ ${CFG.RUG_DROP_PCT}% → SELL NOW`);
          await sellAllViaGMGN(mint);
          return;
        }
      }
      if (imp > Math.max(45, CFG.MAX_PRICE_IMPACT_PCT + 20)) {
        warn(`[RUG] impact ${imp.toFixed(1)}% → SELL NOW`);
        await sellAllViaGMGN(mint);
        return;
      }
    } catch(e) {
      warn('[RUG] probe error:', e.message);
    }
    await sleep(250);
  }
}

/* ====================== Handler (depuis TX confirmée) ====================== */
const seenMint = new Map();     // anti-refire 30s par mint
const seenSig = new Set();      // anti-doublon WS
setInterval(() => { if (seenSig.size > 4000) seenSig.clear(); }, 120000);

async function handleFromTx(sig, tx) {
  const mint  = extractMintFromTx(tx);
  if (!mint) { info(`[SKIP] no mint extracted sig=${sig}`); return; }

  const added = estimateSolAddedFromTx(tx);
  const age   = poolAgeFromTxMs(tx);
  const progs = collectProgramsFromTx(tx);

  // heuristique source
  const src = progs.includes('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA') ? 'PUMP_AMM' : 'unknown';
  const minSol = (src === 'PUMP_AMM') ? CFG.PUMP_TRIGGER_MIN_SOL : CFG.TRIGGER_MIN_SOL;

  if (age != null && age > CFG.MAX_POOL_AGE_MS) {
    info(`[SKIP] old pool (${age}ms > ${CFG.MAX_POOL_AGE_MS}) mint=${mint} src=${src} sig=${sig}`);
    return;
  }
  if (added < minSol) {
    info(`[SKIP] below-threshold (${fmt(added)} < ${minSol}) mint=${mint} src=${src} sig=${sig}`);
    return;
  }

  info(`🚀 token=${mint} | src=${src} | added≈${fmt(added)} SOL | age=${age==null?'n/a':age+'ms'} sig=${sig}`);

  const now = Date.now();
  if (seenMint.get(mint) && now - seenMint.get(mint) < 30000) {
    info(`[SKIP] cooldown 30s mint=${mint} sig=${sig}`);
    return;
  }
  seenMint.set(mint, now);

  try {
    const { route } = await buyViaGMGN(mint);
    const entryRatio = ratioOutOverIn(route.quote) || 0;

    rugGuardAfterBuy({ mint, entryRatio }).catch(()=>{});
    if (CFG.EXIT_TIMEOUT_MS > 0) {
      setTimeout(async () => {
        info(`⏳ Timeout ${CFG.EXIT_TIMEOUT_MS}ms → SELL ALL ${mint}`);
        await sellAllViaGMGN(mint);
      }, CFG.EXIT_TIMEOUT_MS);
    }
  } catch (e) {
    err('Buy failed:', e.message);
  }
}

/* ====================== Helius WS client (logsSubscribe + queue TX) ====================== */
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

const METRICS = { wsLogs:0, txQueued:0, txFetched:0, lastSigAt:0 };

class HeliusWS {
  constructor(url) {
    this.url = url;
    this.ws = null;
    this.subs = new Map();
    this.pinger = null;
    this.reconnTimer = null;
    this.nextId = 1;

    this.txQueue = [];             // signatures à traiter
    this.maxQueue = 800;
    this.queueTimer = null;
  }

  start(programs) {
    this._connect(programs);
    // drain queue à cadence maîtrisée (et confirmer côté RPC)
    this.queueTimer = setInterval(() => this._drainQueue(), 80);
  }

  stop() {
    try { this.ws?.close(); } catch {}
    clearInterval(this.pinger);
    clearInterval(this.queueTimer);
    clearTimeout(this.reconnTimer);
  }

  _connect(programs) {
    this.ws = new WebSocket(this.url);
    this.ws.on('open', () => {
      info('WS connected:', this.url);
      // (re)subscribe
      for (const id of programs) this.logsSubscribeMentions(id, 'processed');
      // keep-alive ping
      clearInterval(this.pinger);
      this.pinger = setInterval(() => { try { this.ws?.ping?.(); } catch{} }, 45000);
    });
    this.ws.on('message', (d) => this._onMessage(d));
    this.ws.on('close', () => {
      warn('WS closed — reconnect in 2s');
      clearInterval(this.pinger);
      clearTimeout(this.reconnTimer);
      this.reconnTimer = setTimeout(() => this._connect(programs), 2000);
    });
    this.ws.on('error', (e) => errOnce('ws', 'WS error:', e.message));
  }

  _send(obj) {
    try { this.ws?.send(JSON.stringify(obj)); } catch (e) { errOnce('wsSend', e.message); }
  }

  logsSubscribeMentions(pubkey, commitment='processed') {
    const id = this.nextId++;
    const payload = {
      jsonrpc: '2.0',
      id,
      method: 'logsSubscribe',
      params: [{ mentions: [pubkey] }, { commitment }],
    };
    this.subs.set(`logs:${pubkey}`, payload);
    this._send(payload);
    info(`WS logs listener started (mentions): ${pubkey}`);
  }

  _enqueueSig(sig) {
    if (!sig || seenSig.has(sig)) return;
    seenSig.add(sig);
    if (this.txQueue.length >= this.maxQueue) this.txQueue.shift();
    this.txQueue.push({ sig, enq: Date.now(), tries: 0 });
    METRICS.txQueued++;
    METRICS.lastSigAt = Date.now();
  }

  async _drainQueue() {
    if (!this.txQueue.length) return;
    // sort: les plus récents en premier
    this.txQueue.sort((a,b) => b.enq - a.enq);

    // traite 1 à 2 signatures par tick selon la backpressure HTTP
    const batch = this.txQueue.splice(0, Math.min(2, this.txQueue.length));
    for (const job of batch) {
      try {
        const tx = await getTransactionCautious(job.sig);
        if (!tx) {
          // requeue si peu d'essais (garde court pour ne pas sortir de la fenêtre 2–4s)
          if (job.tries < CFG.TX_FETCH_RETRIES) {
            job.tries++; job.enq = Date.now();
            this.txQueue.push(job);
          } else {
            dbg('[WS] getTransaction miss sig=', job.sig);
          }
          continue;
        }
        METRICS.txFetched++;
        await handleFromTx(job.sig, tx);
      } catch(e) {
        dbg('drainQueue error:', e.message);
      }
    }
  }

  async _onMessage(data) {
    let msg = null;
    try { msg = JSON.parse(String(data)); } catch { return; }

    if (msg?.method === 'logsNotification') {
      const sig = msg?.params?.result?.value?.signature;
      if (!sig) return;
      METRICS.wsLogs++;
      this._enqueueSig(sig);
      dbg(`[WS] logs sig=${sig}`);
    }
  }
}

/* ====================== Webhook (raw + enhanced) ====================== */
const app = express();
app.use(bodyParser.json({ limit: '20mb' }));

app.post('/helius-webhook', async (req, res) => {
  try {
    // RAW: {signature:"..."} ou body string
    if (req.body && (req.body.signature || req.body.txSig || typeof req.body === 'string')) {
      const sig = req.body.signature || req.body.txSig || (typeof req.body === 'string' ? req.body : null);
      info('RAW webhook sig:', sig);
      const tx = await getTransactionCautious(sig);
      if (!tx) return res.status(200).send({ ok:true, note:'tx-not-found', sig });
      await handleFromTx(sig, tx);
      return res.status(200).send({ ok:true, processed:true, sig });
    }

    // Enhanced (si tu renvoies celles de Helius)
    const payload = Array.isArray(req.body) ? req.body[0] : req.body;
    const sig = payload?.signature || payload?.transaction?.signatures?.[0];
    if (!sig) return res.status(200).send({ ok:true, note:'no-signature' });
    const tx = await getTransactionCautious(sig);
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
    priorityFeeSOL: CFG.PRIORITY_FEE_SOL,
    antiMEV: CFG.ANTI_MEV,
    exitTimeoutMs: CFG.EXIT_TIMEOUT_MS,
    ammPrograms: CFG.AMM_PROGRAM_IDS,
    rpc: { rps: CFG.RPC_RPS, conc: CFG.RPC_MAX_CONCURRENCY, backoffMs: CFG.RPC_BACKOFF_MS },
    wsUrl: CFG.HELIUS_WS_URL ? 'set' : 'missing',
  },
  metrics: METRICS,
}));

/* ====================== Start ====================== */
app.listen(CFG.PORT, () => {
  info(`GMGN sniping listener on :${CFG.PORT} (LOG_LEVEL=${CFG.LOG_LEVEL})`);

  const programs = sanitizedProgramIds(CFG.AMM_PROGRAM_IDS);
  if (programs.length === 0) {
    warn('AMM_PROGRAM_IDS vide → abonnement par défaut UNIQUEMENT sur Pump AMM.');
    programs.push('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');
  }

  const ws = new HeliusWS(CFG.HELIUS_WS_URL);
  ws.start(programs);

  // Heartbeat toutes les 15s
  setInterval(() => {
    info(`[HB] wsLogs=${METRICS.wsLogs} queued=${ws.txQueue.length} fetched=${METRICS.txFetched} lastSigAgo=${METRICS.lastSigAt? (Date.now()-METRICS.lastSigAt)+'ms' : 'n/a'}`);
  }, 15000);
});
