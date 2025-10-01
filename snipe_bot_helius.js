/**
 * snipe_bot_ws_raw_gmgn.js — v2.1 (WS + webhook raw/enhanced → GMGN)
 * - WebSocket filtré par AMM (via AMM_PROGRAM_IDS)
 * - Rate-limit RPC (concurrency + RPS + backoff 429)
 * - Attente courte de confirmation avant getTransaction
 * - Garde-fous route, mini rug-guard, timeout exit
 * - Logs propres + CSV
 */

import 'dotenv/config';
import express from 'express';
import bodyParser from 'body-parser';
import fetch from 'node-fetch';
import fs from 'fs';
import bs58 from 'bs58';
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
  RPC_URL: process.env.RPC_URL || 'https://api.mainnet-beta.solana.com',

  // Filtres d’entrée
  MAX_POOL_AGE_MS: Number(process.env.MAX_POOL_AGE_MS || 2500),
  TRIGGER_MIN_SOL: Number(process.env.TRIGGER_MIN_SOL || 200),
  PUMP_TRIGGER_MIN_SOL: Number(process.env.PUMP_TRIGGER_MIN_SOL || 350),

  // Trade
  TRADE_SIZE_SOL: Number(process.env.TRADE_SIZE_SOL || 0.20),
  MAX_SLIPPAGE: Number(process.env.MAX_SLIPPAGE || 0.30),
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

  // Wallet & base mint
  WALLET_SECRET_KEY: process.env.WALLET_SECRET_KEY || '',
  BASE_SOL_MINT: 'So11111111111111111111111111111111111111112',

  // Logs/CSV
  CSV_FILE: process.env.CSV_FILE || 'live_trades.csv',
  LOG_LEVEL: (process.env.LOG_LEVEL || 'info').toLowerCase(),

  // Filtre WS par programmes (CSV). Vide → "all"
  AMM_PROGRAM_IDS: (process.env.AMM_PROGRAM_IDS || '')
    .split(',').map(s => s.trim()).filter(Boolean),

  // --- RPC rate limit ---
  RPC_MAX_CONCURRENCY: Number(process.env.RPC_MAX_CONCURRENCY || 3), // appels HTTP en parallèle
  RPC_RPS: Number(process.env.RPC_RPS || 8),                          // requêtes/seconde max
  RPC_BACKOFF_MS: Number(process.env.RPC_BACKOFF_MS || 600),          // backoff de base si 429
};

/* ====================== Logger ====================== */
const dbg  = (...a) => { if (CFG.LOG_LEVEL === 'debug') console.log(...a); };
const info = (...a) => console.log(...a);
const warn = (...a) => console.warn(...a);
const err  = (...a) => console.error(...a);

// Anti-spam pour erreurs répétées
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

if (!CFG.WALLET_SECRET_KEY) { err('❌ WALLET_SECRET_KEY manquant'); process.exit(1); }
if (!CFG.GMGN_HOST) { err('❌ GMGN_HOST manquant'); process.exit(1); }

if (!fs.existsSync(CFG.CSV_FILE)) fs.writeFileSync(CFG.CSV_FILE, 'time,event,side,sol,token,extra\n');
const csv = (r) => {
  const line = `${new Date().toISOString()},${r.event},${r.side||''},${r.sol||''},${r.token||''},${r.extra||''}\n`;
  fs.appendFileSync(CFG.CSV_FILE, line);
};

/* ====================== Setup ====================== */
// Connexion en processed pour la vitesse (WS) ; getTransaction passera par wrapper avec confirmed/finalized.
const connection = new Connection(CFG.RPC_URL, { commitment: 'processed' });
const wallet = Keypair.fromSecretKey(bs58.decode(CFG.WALLET_SECRET_KEY));
const WALLET_PK = wallet.publicKey.toBase58();

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const fmt = (n, d=6) => (typeof n === 'number' ? Number(n).toFixed(d) : n);

/* ---------- RPC limiter (concurrency + RPS + 429 backoff) ---------- */
let running = 0;
let tokens = 0;
let lastRefill = Date.now();
const queue = [];

function refillTokens() {
  const now = Date.now();
  const elapsed = now - lastRefill;
  const add = Math.floor((elapsed / 1000) * CFG.RPC_RPS);
  if (add > 0) {
    tokens = Math.min(tokens + add, CFG.RPC_RPS);
    lastRefill = now;
  }
}
function tryDequeue() {
  refillTokens();
  while (running < CFG.RPC_MAX_CONCURRENCY && tokens > 0 && queue.length) {
    tokens--;
    const job = queue.shift();
    running++;
    job();
  }
}
async function scheduleRpc(fn) {
  return new Promise((resolve, reject) => {
    const run = async () => {
      try {
        const res = await fn();
        resolve(res);
      } catch (e) {
        reject(e);
      } finally {
        running--;
        tryDequeue();
      }
    };
    queue.push(run);
    tryDequeue();
  });
}
// Wrapper général avec gestion 429
async function rpcCall(label, fn, { retries = 3 } = {}) {
  let attempt = 0;
  // exécute via rate-limiter
  while (true) {
    try {
      return await scheduleRpc(fn);
    } catch (e) {
      const msg = String(e?.message || e);
      const is429 = msg.includes('429') || msg.includes('Too Many Requests');
      if (is429 && attempt < retries) {
        attempt++;
        const wait = CFG.RPC_BACKOFF_MS * attempt; // backoff linéaire
        dbg(`${label}: 429 → backoff ${wait}ms (attempt ${attempt}/${retries})`);
        await sleep(wait);
        continue;
      }
      throw e;
    }
  }
}

/* ====================== Helpers extraction ====================== */
function tsFromPayloadMs(payload) {
  const t = payload?.timestamp ?? payload?.blockTime;
  if (!t) return null;
  return Number(t) * 1000;
}
function poolAgeMs(payload) {
  const t = tsFromPayloadMs(payload);
  if (!t) return null;
  return Date.now() - t;
}
function estimateSolAdded(payload) {
  const solMint = CFG.BASE_SOL_MINT;
  const t = payload?.tokenTransfers || [];
  let by = 0;
  for (const x of t) if (x.mint === solMint && x.tokenAmount > 0) by += Number(x.tokenAmount);
  if (by > 0) return by;
  // fallback balances
  const pre = payload?.meta?.preBalances || [];
  const post = payload?.meta?.postBalances || [];
  if (pre.length && post.length) {
    let delta = 0;
    for (let i=0;i<post.length;i++) {
      const diff = (post[i] - (pre[i]||0));
      if (diff > 0) delta += diff / LAMPORTS_PER_SOL;
    }
    if (delta > 0) return delta;
  }
  return 0;
}
function extractMint(payload) {
  const acc = payload?.accountData || [];
  const deltas = new Map();
  for (const a of acc) {
    for (const t of (a.tokenBalanceChanges || [])) {
      const mint = t.mint;
      const raw = Number(t.rawTokenAmount?.tokenAmount || 0);
      if (raw > 0) deltas.set(mint, (deltas.get(mint) || 0) + raw / (10 ** (t.rawTokenAmount?.decimals ?? 9)));
    }
  }
  if (deltas.size) return [...deltas.entries()].sort((a,b)=>b[1]-a[1])[0][0];

  const pre = payload?.meta?.preTokenBalances || [];
  const post = payload?.meta?.postTokenBalances || [];
  const byMint = {};
  for (const p of post) {
    const mint = p.mint;
    const postAmt = Number(p.uiTokenAmount?.uiAmount || 0);
    const preEntry = pre.find(x => x.accountIndex === p.accountIndex);
    const preAmt = preEntry ? Number(preEntry.uiTokenAmount?.uiAmount || 0) : 0;
    const delta = postAmt - preAmt;
    if (delta > 0) byMint[mint] = (byMint[mint] || 0) + delta;
  }
  const cand = Object.entries(byMint).sort((a,b)=>b[1]-a[1]);
  return cand.length ? cand[0][0] : null;
}
function collectProgramsFromTxPayload(payload) {
  const seen = new Set();
  const keys = payload?.transaction?.message?.accountKeys || [];
  if (payload?.programId) seen.add(String(payload.programId));
  for (const ins of (payload?.transaction?.message?.instructions || [])) {
    if (ins.programId) seen.add(String(ins.programId));
    if (ins.programIdIndex !== undefined && keys[ins.programIdIndex]) seen.add(String(keys[ins.programIdIndex]));
  }
  for (const grp of (payload?.meta?.innerInstructions || [])) {
    for (const ins of (grp.instructions || [])) {
      if (ins.programId) seen.add(String(ins.programId));
      if (ins.programIdIndex !== undefined && keys[ins.programIdIndex]) seen.add(String(keys[ins.programIdIndex]));
    }
  }
  return [...seen];
}

/* ====================== GMGN helpers ====================== */
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

/* ====================== Guards ====================== */
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
      const maxMs = 8000;
      const t0 = Date.now();
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
  const resp = await rpcCall('getTokenAccountsByOwner',
    () => connection.getTokenAccountsByOwner(ownerPk, { mint: mintPk })
  );
  let total = 0n;
  for (const it of resp.value) {
    const acc = await rpcCall('getParsedAccountInfo',
      () => connection.getParsedAccountInfo(it.pubkey)
    );
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
      const maxMs = 8000;
      const t0 = Date.now();
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

/* ====================== Unified handler ====================== */
const seenMint = new Map(); // anti-refire 30s par mint
const seenSig  = new Set(); // anti-doublon WS
setInterval(() => { if (seenSig.size > 4000) seenSig.clear(); }, 120000);

async function handleDetected(payload, srcHint = 'unknown', extra = {}) {
  try {
    const t = payload?.type || 'UNKNOWN';
    const src = payload?.source || srcHint || 'unknown';
    const mint = extractMint(payload);
    const added = estimateSolAdded(payload);
    const age = poolAgeMs(payload);

    if (!mint) { dbg('skip: no mint'); return { ok:false, reason:'no-mint' }; }

    info(`🚀 token=${mint} | type=${t} src=${src} | added≈${fmt(added,6)} SOL | age=${age==null?'n/a':age+'ms'} ${extra.signature ? 'sig='+extra.signature : ''}`);

    const minSol = (src === 'PUMP_AMM') ? CFG.PUMP_TRIGGER_MIN_SOL : CFG.TRIGGER_MIN_SOL;

    if (age != null && age > CFG.MAX_POOL_AGE_MS) return { ok:false, reason:'old-pool', age };
    if (added < minSol) return { ok:false, reason:'below-threshold', added, minSol };

    const now = Date.now();
    if (seenMint.get(mint) && now - seenMint.get(mint) < 30000) return { ok:false, reason:'cooldown' };
    seenMint.set(mint, now);

    try {
      const { route, hash } = await buyViaGMGN(mint);
      const entryRatio = ratioOutOverIn(route.quote) || 0;

      rugGuardAfterBuy({ mint, entryRatio }).catch(()=>{});
      if (CFG.EXIT_TIMEOUT_MS > 0) {
        setTimeout(async () => {
          info(`⏳ Timeout ${CFG.EXIT_TIMEOUT_MS}ms → SELL ALL ${mint}`);
          await sellAllViaGMGN(mint);
        }, CFG.EXIT_TIMEOUT_MS);
      }
      return { ok:true, mint, hash, added, src };
    } catch (e) {
      err('Buy failed:', e.message);
      return { ok:false, reason:'buy-failed', err:e.message };
    }
  } catch (e) {
    err('handleDetected error:', e);
    return { ok:false, reason:'internal', err:e.message };
  }
}

/* ====================== Fetch tx — wait confirmed ====================== */
async function waitSignatureConfirmed(sig, maxWaitMs = 1500, pollMs = 150) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxWaitMs) {
    try {
      const st = await rpcCall('getSignatureStatuses',
        () => connection.getSignatureStatuses([sig], { searchTransactionHistory: true })
      );
      const s = st?.value?.[0];
      if (s?.err) return false;
      const cs = s?.confirmationStatus;
      const confs = s?.confirmations;
      if (cs === 'confirmed' || cs === 'finalized' || (typeof confs === 'number' && confs >= 1)) return true;
    } catch (e) {
      errOnce('sigStatus', 'getSignatureStatuses err:', e.message);
    }
    await sleep(pollMs);
  }
  return false;
}

async function fetchTransactionConfirmed(sig) {
  try {
    const tx = await rpcCall('getTransaction(confirmed)',
      () => connection.getTransaction(sig, { commitment:'confirmed', maxSupportedTransactionVersion: 0 })
    );
    if (tx) return tx;
  } catch (e) {
    errOnce('getTxConfirmed', e.message);
  }
  try {
    const tx = await rpcCall('getTransaction(finalized)',
      () => connection.getTransaction(sig, { commitment:'finalized', maxSupportedTransactionVersion: 0 })
    );
    if (tx) return tx;
  } catch (e) {
    errOnce('getTxFinalized', e.message);
  }
  return null;
}

async function fetchTxAfterConfirmed(sig) {
  const ok = await waitSignatureConfirmed(sig, 1500, 150);
  if (!ok) return null;
  return await fetchTransactionConfirmed(sig);
}

/* ====================== WebSocket logs ====================== */
function startLogsListener() {
  try {
    if (!CFG.AMM_PROGRAM_IDS.length) {
      connection.onLogs('all', onLogsHandler, 'processed');
      info('WS logs listener started for ALL (⚠️ bruyant, conseille d’utiliser AMM_PROGRAM_IDS)');
      return;
    }
    for (const id of CFG.AMM_PROGRAM_IDS) {
      try {
        const pk = new PublicKey(id);
        connection.onLogs(pk, onLogsHandler, 'processed');
        info(`WS logs listener started for program (mentions): ${pk.toBase58()}`);
      } catch (e) {
        warn(`Invalid AMM program id in AMM_PROGRAM_IDS: ${id} → ${e.message}`);
      }
    }
  } catch (e) {
    warn('startLogsListener failed:', e.message);
  }
}

async function onLogsHandler(logInfo) {
  const sig = logInfo?.signature;
  if (!sig) return;
  if (seenSig.has(sig)) return;
  if (seenSig.size > 5000) seenSig.clear();
  seenSig.add(sig);

  const tx = await fetchTxAfterConfirmed(sig);
  if (!tx) { dbg('tx not found for sig', sig); return; }

  const payload = {
    transaction: tx.transaction,
    meta: tx.meta,
    slot: tx.slot,
    timestamp: tx.blockTime || null,
  };
  const progs = collectProgramsFromTxPayload(payload);
  let src = 'unknown';
  if (progs.includes('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA')) src = 'PUMP_AMM';

  await handleDetected(payload, src, { signature: sig });
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

      const tx = await fetchTxAfterConfirmed(sig);
      if (!tx) {
        warn('raw webhook: tx not found (confirmed timeout) sig', sig);
        return res.status(200).send({ ok:true, note:'tx-not-found', sig });
      }
      const payload = { transaction: tx.transaction, meta: tx.meta, slot: tx.slot, timestamp: tx.blockTime || null };
      const progs = collectProgramsFromTxPayload(payload);
      let src = 'unknown';
      if (progs.includes('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA')) src = 'PUMP_AMM';
      const r = await handleDetected(payload, src, { signature: sig });
      return res.status(200).send(r);
    }

    // Enhanced Helius
    const payload = Array.isArray(req.body) ? req.body[0] : req.body;
    const t = payload?.type || 'UNKNOWN';
    const src = payload?.source || 'unknown';
    if (!['CREATE_POOL','ADD_LIQUIDITY'].includes(t)) {
      dbg(`skip: ignored-type (${t})`);
      return res.status(200).send({ ok:true, note:'ignored-type', type:t });
    }
    const r = await handleDetected(payload, src, {});
    return res.status(200).send(r);
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
    rpcLimit: { maxConc: CFG.RPC_MAX_CONCURRENCY, rps: CFG.RPC_RPS, backoffMs: CFG.RPC_BACKOFF_MS },
  },
}));

/* ====================== Start ====================== */
app.listen(CFG.PORT, () => {
  info(`GMGN sniping listener on :${CFG.PORT} (LOG_LEVEL=${CFG.LOG_LEVEL})`);
  startLogsListener();
});
