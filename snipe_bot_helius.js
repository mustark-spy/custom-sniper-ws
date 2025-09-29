/**
 * snipe_gmgn.js
 *
 * Helius webhook -> detect CREATE_POOL / ADD_LIQUIDITY -> LIVE buy via GMGN Router
 * Sign locally (base58 secret key) -> submit via GMGN txproxy.
 * Includes TP/SL/trailing + optional timeout exit.
 *
 * Quick start:
 *  npm i express body-parser node-fetch @solana/web3.js bs58
 *  export WALLET_SECRET_KEY=....   # base58
 *  node snipe_gmgn.js
 */

import 'dotenv/config';
import express from 'express';
import bodyParser from 'body-parser';
import fetch from 'node-fetch';
import fs from 'fs';
import bs58 from 'bs58';
import {
  Connection,
  Keypair,
  VersionedTransaction,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';

// ====================== Config ======================
const CFG = {
  MODE: (process.env.MODE || 'live').toLowerCase(),
  PORT: Number(process.env.PORT || 10000),

  // RPC pour lecture des balances & décimales
  RPC_URL: process.env.RPC_URL || 'https://api.mainnet-beta.solana.com',
  SOL_MINT: process.env.BASE_SOL_MINT || 'So11111111111111111111111111111111111111112',

  // Déclencheur
  TRIGGER_MIN_SOL: Number(process.env.TRIGGER_MIN_SOL || 200),

  // Trade
  TRADE_SIZE_SOL: Number(process.env.TRADE_SIZE_SOL || 0.15),
  MAX_SLIPPAGE: Number(process.env.MAX_SLIPPAGE || 0.30), // 0.30 => 30%
  PRIORITY_FEE_SOL: Number(process.env.PRIORITY_FEE_SOL || 0.008),

  // Stratégie
  TP1_PCT: Number(process.env.TP1_PCT || 0.40),     // +40%
  TP1_SELL: Number(process.env.TP1_SELL || 0.70),   // 70% à TP1
  TRAIL_GAP: Number(process.env.TRAIL_GAP || 0.15), // trailing 15%
  HARD_SL: Number(process.env.HARD_SL || 0.35),     // stop dur -35%
  EXIT_TIMEOUT_MS: Number(process.env.EXIT_TIMEOUT_MS || 15000), // 0 => off

  // GMGN Router (pas d'API key requise)
  GMGN_HOST: (process.env.GMGN_HOST || 'https://gmgn.ai').replace(/\/$/, ''),
  // Anti-MEV (Jito) & fee (SOL) optionnels
  GMGN_ANTI_MEV: ['1','true','yes'].includes(String(process.env.GMGN_ANTI_MEV || '').toLowerCase()),
  GMGN_FEE_SOL: process.env.GMGN_FEE_SOL ? Number(process.env.GMGN_FEE_SOL) : undefined, // ex: 0.006

  // AMM allowlist (optionnel)
  AMM_PROGRAM_IDS: (process.env.AMM_PROGRAM_IDS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean),
  AMM_STRICT: ['1','true','yes'].includes(String(process.env.AMM_STRICT || '').toLowerCase()),

  // Wallet
  WALLET_SECRET_KEY: process.env.WALLET_SECRET_KEY || '',

  // Logs/CSV
  CSV_FILE: process.env.CSV_FILE || 'live_trades.csv',
  LOG_LEVEL: (process.env.LOG_LEVEL || 'info').toLowerCase(),
};

const dbg  = (...a) => { if (CFG.LOG_LEVEL === 'debug') console.log(...a); };
const info = (...a) => console.log(...a);
const warn = (...a) => console.warn(...a);
const err  = (...a) => console.error(...a);

if (!CFG.WALLET_SECRET_KEY) { err('❌ WALLET_SECRET_KEY manquant (base58)'); process.exit(1); }

// ====================== Setup ======================
const connection = new Connection(CFG.RPC_URL, { commitment: 'processed' });
const wallet = Keypair.fromSecretKey(bs58.decode(CFG.WALLET_SECRET_KEY));
const WALLET_PK = wallet.publicKey.toBase58();

if (!fs.existsSync(CFG.CSV_FILE)) {
  fs.writeFileSync(CFG.CSV_FILE, 'time,event,side,price,sol,token,extra\n');
}
const csv = (r) => {
  const line = `${new Date().toISOString()},${r.event},${r.side||''},${r.price||''},${r.sol||''},${r.token||''},${r.extra||''}\n`;
  fs.appendFileSync(CFG.CSV_FILE, line);
};

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const fmt = (n) => Number(n).toFixed(6);

// ====================== Utils Helius payload ======================
function extractMint(payload) {
  const acc = payload?.accountData || [];
  const deltas = new Map();
  for (const a of acc) {
    for (const t of (a.tokenBalanceChanges || [])) {
      const mint = t.mint;
      const raw = Number(t.rawTokenAmount?.tokenAmount || 0);
      if (raw > 0) {
        const dec = Number(t.rawTokenAmount?.decimals ?? 9);
        deltas.set(mint, (deltas.get(mint) || 0) + raw / (10 ** dec));
      }
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

function estimateSolAdded(payload) {
  const solMint = CFG.SOL_MINT;
  const t = payload?.tokenTransfers || [];
  let by = 0;
  for (const x of t) if (x.mint === solMint && x.tokenAmount > 0) by += Number(x.tokenAmount);
  if (by > 0) return by;

  // fallback via parsed lamports
  let lamports = 0;
  const top = payload?.transaction?.message?.instructions || [];
  const inner = payload?.meta?.innerInstructions || [];
  const scan = (ins) => {
    if (ins?.parsed?.type === 'transfer' && ins?.parsed?.info?.lamports) lamports += Number(ins.parsed.info.lamports);
  };
  top.forEach(scan);
  inner.forEach(g => (g.instructions || []).forEach(scan));
  return lamports / LAMPORTS_PER_SOL;
}

function collectPrograms(payload) {
  const keys = payload?.transaction?.message?.accountKeys || [];
  const seen = new Set();
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
function ammAllowed(payload) {
  if (!CFG.AMM_PROGRAM_IDS.length) return true;
  const seen = collectPrograms(payload);
  dbg('[amm] seen programs =>', JSON.stringify(seen));
  const allow = new Set(CFG.AMM_PROGRAM_IDS);
  const any = seen.some(p => allow.has(p));
  if (CFG.AMM_STRICT) return any;
  return true;
}

// ====================== GMGN Router ======================
// Build route URL for swap (ExactIn) with optional fee & anti-mev
function gmgnRouteUrl({ tokenIn, tokenOut, inLamports, fromAddress, slippagePct, feeSol, isAntiMev }) {
  const u = new URL(`${CFG.GMGN_HOST}/defi/router/v1/sol/tx/get_swap_route`);
  u.searchParams.set('token_in_address', tokenIn);
  u.searchParams.set('token_out_address', tokenOut);
  u.searchParams.set('in_amount', String(inLamports));         // lamports of input token
  u.searchParams.set('from_address', fromAddress);
  u.searchParams.set('slippage', String(slippagePct));         // percent (e.g., 10)
  // optional:
  if (feeSol !== undefined) u.searchParams.set('fee', String(feeSol));
  if (isAntiMev) u.searchParams.set('is_anti_mev', 'true');
  return u.toString();
}

// GET route (unsigned swap tx base64 in data.raw_tx.swapTransaction)
async function gmgnGetRoute({ tokenIn, tokenOut, inLamports, fromAddress, slippagePct, feeSol, isAntiMev }) {
  const url = gmgnRouteUrl({ tokenIn, tokenOut, inLamports, fromAddress, slippagePct, feeSol, isAntiMev });
  const res = await fetch(url, { method: 'GET', headers: { accept: 'application/json' } });
  const text = await res.text(); // pour debug en cas d'erreur de parse
  if (!res.ok) {
    throw new Error(`GMGN route ${res.status}: ${text}`);
  }
  let json;
  try { json = JSON.parse(text); } catch { throw new Error(`GMGN route parse error: ${text}`); }
  if (json.code !== 0 || !json.data?.raw_tx?.swapTransaction) {
    throw new Error(`GMGN route invalid: ${JSON.stringify(json)}`);
  }
  return json.data; // { quote, raw_tx:{ swapTransaction, lastValidBlockHeight, recentBlockhash, prioritizationFeeLamports } }
}

// Submit signed tx
async function gmgnSubmitSignedTx({ signedBase64, isAntiMev=false }) {
  const url = `${CFG.GMGN_HOST}/txproxy/v1/send_transaction`;
  const body = { chain: 'sol', signedTx: signedBase64 };
  if (isAntiMev) body.isAntiMev = true;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type':'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`GMGN submit ${res.status}: ${text}`);
  let json; try { json = JSON.parse(text); } catch { throw new Error(`GMGN submit parse error: ${text}`); }
  if (json.code !== 0 || !json.data?.hash) throw new Error(`GMGN submit err: ${text}`);
  return json.data; // { hash, resArr: [...] }
}

// Poll tx status
async function gmgnCheckStatus({ hash, lastValidBlockHeight }) {
  const u = new URL(`${CFG.GMGN_HOST}/defi/router/v1/sol/tx/get_transaction_status`);
  u.searchParams.set('hash', hash);
  if (lastValidBlockHeight) u.searchParams.set('last_valid_height', String(lastValidBlockHeight));
  const res = await fetch(u.toString(), { headers: { accept: 'application/json' }});
  const text = await res.text();
  if (!res.ok) throw new Error(`GMGN status ${res.status}: ${text}`);
  let json; try { json = JSON.parse(text); } catch { throw new Error(`GMGN status parse error: ${text}`); }
  return json; // { code, msg, data:{ success, failed, expired } }
}

// ====================== Sell helpers ======================
// Récupère balance & décimales SPL pour un mint donné
async function getTokenBalanceAndDecimals(ownerPubkey, mint) {
  const owner = wallet.publicKey;
  const resp = await connection.getParsedTokenAccountsByOwner(owner, { mint: new PublicKey(mint) });
  let uiAmount = 0, decimals = 9;
  for (const acc of resp.value) {
    const info = acc?.account?.data?.parsed?.info;
    const tok = info?.tokenAmount;
    if (!tok) continue;
    decimals = tok.decimals ?? decimals;
    uiAmount += Number(tok.uiAmount || 0);
  }
  return { uiAmount, decimals };
}

// ====================== Strategy state ======================
let position = null; // { mint, entry, high, remainingPct, startedAt }

const trailStopPrice = (p) => p.high * (1 - CFG.TRAIL_GAP);

// ====================== BUY (GMGN) ======================
async function liveBuyGMGN(mint) {
  // Construire un swap SOL -> mint via GMGN (ExactIn, in_amount en lamports de SOL)
  const inLamports = Math.floor(CFG.TRADE_SIZE_SOL * LAMPORTS_PER_SOL);
  const slippagePct = Math.round(CFG.MAX_SLIPPAGE * 100); // GMGN veut un pourcentage (ex 10)
  const route = await gmgnGetRoute({
    tokenIn: CFG.SOL_MINT,
    tokenOut: mint,
    inLamports,
    fromAddress: WALLET_PK,
    slippagePct,
    feeSol: CFG.GMGN_FEE_SOL,           // optionnel
    isAntiMev: CFG.GMGN_ANTI_MEV,      // optionnel
  });

  const b64 = route.raw_tx.swapTransaction;
  const buf = Buffer.from(b64, 'base64');
  const tx = VersionedTransaction.deserialize(buf);
  tx.sign([wallet]);
  const signedB64 = Buffer.from(tx.serialize()).toString('base64');

  const submit = await gmgnSubmitSignedTx({ signedBase64: signedB64, isAntiMev: CFG.GMGN_ANTI_MEV });
  const hash = submit.hash;

  info(`🟢 [BUY sent GMGN] hash=${hash}`);
  csv({ event:'enter', side:'BUY', price:'', sol:CFG.TRADE_SIZE_SOL, token:mint, extra:`hash=${hash}` });

  // Définir un entryGuess avec le quote renvoyé
  let entryGuess = 0.000001;
  try {
    const inAmt = Number(route.quote.inAmount)  / (10 ** (route.quote?.inAmountDecimals ?? 9));  // SOL
    const outAmt= Number(route.quote.outAmount) / (10 ** (route.quote?.outAmountDecimals ?? 9)); // TOKEN
    if (inAmt > 0 && outAmt > 0) entryGuess = (inAmt / outAmt) * (1 + 0.5 * CFG.MAX_SLIPPAGE);
  } catch {}

  position = {
    mint,
    entry: entryGuess,
    high: entryGuess,
    remainingPct: 1.0,
    startedAt: Date.now(),
  };

  // optionnel: petit poll de statut en tâche de fond (non bloquant)
  (async () => {
    try {
      const lastValid = route.raw_tx.lastValidBlockHeight;
      for (let i=0;i<12;i++) {
        await sleep(1000);
        const st = await gmgnCheckStatus({ hash, lastValidBlockHeight: lastValid });
        dbg('[status]', st);
        if (st?.data?.success || st?.data?.expired || st?.data?.failed) break;
      }
    } catch(e) { dbg('status poll error:', e.message); }
  })();

  // Lancer la gestion
  managePositionLoop().catch(()=>{});
  if (CFG.EXIT_TIMEOUT_MS > 0) {
    setTimeout(async () => {
      if (position && position.mint === mint) {
        info(`⏳ Timeout ${CFG.EXIT_TIMEOUT_MS}ms => sortie totale`);
        await liveSellPct(1.0);
      }
    }, CFG.EXIT_TIMEOUT_MS);
  }
}

// ====================== SELL (GMGN) ======================
async function liveSellPct(pct) {
  if (!position || pct <= 0) return;
  const sellMint = position.mint;
  const { uiAmount, decimals } = await getTokenBalanceAndDecimals(wallet.publicKey, sellMint);
  if (uiAmount <= 0) {
    warn('Sell skipped: no token balance');
    position = null;
    return;
  }

  const sellUi = Math.max(0, Math.min(uiAmount * pct, uiAmount));
  const inLamports = Math.floor(sellUi * (10 ** decimals));
  const slippagePct = Math.round(CFG.MAX_SLIPPAGE * 100);

  // Route TOKEN -> SOL
  const route = await gmgnGetRoute({
    tokenIn: sellMint,
    tokenOut: CFG.SOL_MINT,
    inLamports,
    fromAddress: WALLET_PK,
    slippagePct,
    feeSol: CFG.GMGN_FEE_SOL,
    isAntiMev: CFG.GMGN_ANTI_MEV,
  });

  const b64 = route.raw_tx.swapTransaction;
  const buf = Buffer.from(b64, 'base64');
  const tx = VersionedTransaction.deserialize(buf);
  tx.sign([wallet]);
  const signedB64 = Buffer.from(tx.serialize()).toString('base64');

  const submit = await gmgnSubmitSignedTx({ signedBase64: signedB64, isAntiMev: CFG.GMGN_ANTI_MEV });
  const hash = submit.hash;

  info(`🔴 [SELL sent GMGN] pct=${Math.round(pct*100)}% hash=${hash}`);
  csv({ event:'exit', side:'SELL', price:'', sol:'', token:sellMint, extra:`pct=${pct}|hash=${hash}` });

  position.remainingPct = Math.max(0, position.remainingPct - pct);
  if (position.remainingPct <= 1e-9) position = null;
}

// ====================== Gestion TP/SL/Trailing ======================
async function spotPriceFromQuote(mint) {
  // estimation du prix via GMGN quote (SOL->token) ExactIn avec TRADE_SIZE_SOL
  try {
    const route = await gmgnGetRoute({
      tokenIn: CFG.SOL_MINT,
      tokenOut: mint,
      inLamports: Math.floor(CFG.TRADE_SIZE_SOL * LAMPORTS_PER_SOL),
      fromAddress: WALLET_PK,
      slippagePct: Math.round(CFG.MAX_SLIPPAGE * 100),
      feeSol: CFG.GMGN_FEE_SOL,
      isAntiMev: CFG.GMGN_ANTI_MEV,
    });
    const inAmt = Number(route.quote.inAmount)  / (10 ** (route.quote?.inAmountDecimals ?? 9));
    const outAmt= Number(route.quote.outAmount) / (10 ** (route.quote?.outAmountDecimals ?? 9));
    if (inAmt > 0 && outAmt > 0) return inAmt / outAmt;
  } catch {}
  return null;
}

async function managePositionLoop() {
  while (position) {
    const px = await spotPriceFromQuote(position.mint) || position.entry;
    if (px > position.high) position.high = px;

    const up = px / position.entry - 1;
    const down = 1 - px / position.entry;

    // TP1
    if (position.remainingPct > 0.99 && up >= CFG.TP1_PCT) {
      await liveSellPct(CFG.TP1_SELL);
      position && (position.remainingPct = Math.max(0, position.remainingPct));
    }

    // trailing sur le reste
    if (position && position.remainingPct <= 0.30) {
      const tstop = position.high * (1 - CFG.TRAIL_GAP);
      if (px <= tstop) {
        await liveSellPct(1.0);
        break;
      }
    }

    // stop dur
    if (down >= CFG.HARD_SL) {
      await liveSellPct(1.0);
      break;
    }

    await sleep(140);
  }
}

// ====================== Webhook ======================
const app = express();
app.use(bodyParser.json({ limit: '20mb' }));

const seenMint = new Map(); // anti-refire 30s

app.post('/helius-webhook', async (req, res) => {
  try {
    const payload = Array.isArray(req.body) ? req.body[0] : req.body;
    const type = payload?.type || 'UNKNOWN';
    const src  = payload?.source || 'unknown';

    if (!['CREATE_POOL', 'ADD_LIQUIDITY'].includes(type)) {
      return res.status(200).send({ ok:true, note:'ignored-type', type });
    }

    if (!ammAllowed(payload)) {
      return res.status(200).send({ ok:true, note:'amm-filter-skip', strict:CFG.AMM_STRICT, allow:CFG.AMM_PROGRAM_IDS });
    }

    const mint = extractMint(payload);
    if (!mint) {
      warn('skip: no-mint');
      return res.status(200).send({ ok:true, note:'no-mint' });
    }

    const added = estimateSolAdded(payload);
    info(`🚀 Nouveau token: ${mint} | type=${type} src=${src} | ~${fmt(added)} SOL ajoutés`);
    csv({ event:'detect', price:'', sol:added, token:mint, extra:`type=${type}|source=${src}` });

    if (added < CFG.TRIGGER_MIN_SOL) {
      return res.status(200).send({ ok:true, note:'below-threshold', added });
    }

    const now = Date.now();
    if (seenMint.get(mint) && (now - seenMint.get(mint) < 30000)) {
      return res.status(200).send({ ok:true, note:'cooldown' });
    }
    seenMint.set(mint, now);

    // BUY via GMGN
    try {
      await liveBuyGMGN(mint);
      return res.status(200).send({ ok:true, triggered:true, mint, added });
    } catch (e) {
      err('Buy failed:', e.message);
      return res.status(200).send({ ok:true, note:'buy-failed', err: e.message });
    }
  } catch (e) {
    err('webhook error:', e);
    return res.status(500).send({ ok:false, error: e.message });
  }
});

app.get('/health', (_req, res) => res.send({
  ok: true,
  mode: CFG.MODE,
  wallet: WALLET_PK,
  triggerMinSol: CFG.TRIGGER_MIN_SOL,
  tp1: { pct: CFG.TP1_PCT, sell: CFG.TP1_SELL },
  trail: CFG.TRAIL_GAP,
  hardSL: CFG.HARD_SL,
  timeoutMs: CFG.EXIT_TIMEOUT_MS,
  gmgn: { host: CFG.GMGN_HOST, antiMev: CFG.GMGN_ANTI_MEV, feeSol: CFG.GMGN_FEE_SOL ?? null },
}));

app.listen(CFG.PORT, () => {
  info(`GMGN sniping listener on :${CFG.PORT} (LOG_LEVEL=${CFG.LOG_LEVEL})`);
});
