/**
 * Sniper Solana (GMGN Router)
 * - Détecte les nouveaux pools via webhook Helius (CREATE_POOL / ADD_LIQUIDITY)
 * - Achats / Ventes via GMGN:
 *    1) GET swap route (unsigned Tx base64)
 *    2) Signature locale
 *    3) POST signed tx (txproxy)
 *    4) Poll statut jusqu’à success / expired / failed
 * - Gestion TP1 / Trailing / Hard SL / Timeout
 *
 * ENV attendus (exemples):
 *   MODE=live
 *   PORT=10000
 *   RPC_URL=https://api.mainnet-beta.solana.com
 *   WALLET_SECRET_KEY=base58-SECRET
 *
 *   TRIGGER_MIN_SOL=60
 *   TRADE_SIZE_SOL=0.15
 *   MAX_SLIPPAGE=0.30        # 0.30 => 30% envoyé à GMGN
 *
 *   GMGN_HOST=https://gmgn.ai
 *   GMGN_ANTI_MEV=0|1
 *   GMGN_FEE_SOL=0.003       # optionnel (si Anti-MEV true, GMGN conseille >= 0.002)
 *
 *   CSV_FILE=live_trades.csv
 *   LOG_LEVEL=debug|info
 */

import 'dotenv/config';
import express from 'express';
import bodyParser from 'body-parser';
import fetch from 'node-fetch';
import fs from 'fs';
import bs58 from 'bs58';
import {
  Connection,
  LAMPORTS_PER_SOL,
  VersionedTransaction,
  Keypair,
  PublicKey,
} from '@solana/web3.js';

// -------------------- Config --------------------
const CFG = {
  MODE: (process.env.MODE || 'live').toLowerCase(),
  PORT: Number(process.env.PORT || 10000),
  RPC_URL: process.env.RPC_URL || 'https://api.mainnet-beta.solana.com',

  TRIGGER_MIN_SOL: Number(process.env.TRIGGER_MIN_SOL || 60),

  TRADE_SIZE_SOL: Number(process.env.TRADE_SIZE_SOL || 0.15),
  MAX_SLIPPAGE: Number(process.env.MAX_SLIPPAGE || 0.30), // sous forme 0.30 => 30%

  GMGN_HOST: process.env.GMGN_HOST || 'https://gmgn.ai',
  GMGN_ANTI_MEV: ['1','true','yes'].includes(String(process.env.GMGN_ANTI_MEV || 0).toLowerCase()),
  GMGN_FEE_SOL: Number.isFinite(Number(process.env.GMGN_FEE_SOL)) ? Number(process.env.GMGN_FEE_SOL) : undefined,

  BASE_SOL_MINT: 'So11111111111111111111111111111111111111112',

  WALLET_SECRET_KEY: process.env.WALLET_SECRET_KEY || '', // base58

  CSV_FILE: process.env.CSV_FILE || 'live_trades.csv',
  LOG_LEVEL: (process.env.LOG_LEVEL || 'info').toLowerCase(),
};

const dbg  = (...a) => { if (CFG.LOG_LEVEL === 'debug') console.log(...a); };
const info = (...a) => console.log(...a);
const warn = (...a) => console.warn(...a);
const err  = (...a) => console.error(...a);

if (!CFG.WALLET_SECRET_KEY) { err('❌ WALLET_SECRET_KEY manquant'); process.exit(1); }

// -------------------- Setup --------------------
const connection = new Connection(CFG.RPC_URL, { commitment: 'processed' });
const wallet = Keypair.fromSecretKey(bs58.decode(CFG.WALLET_SECRET_KEY));
const WALLET_PK = wallet.publicKey.toBase58();

if (!fs.existsSync(CFG.CSV_FILE)) {
  fs.writeFileSync(CFG.CSV_FILE, 'time,event,side,price,sol,token,extra\n');
}
const csv = (row) => {
  const line = `${new Date().toISOString()},${row.event},${row.side||''},${row.price||''},${row.sol||''},${row.token||''},${row.extra||''}\n`;
  fs.appendFileSync(CFG.CSV_FILE, line);
};

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const fmt = (n, d=6) => Number(n).toFixed(d);

// -------------------- Outils prix (Jupiter quote ONLY) --------------------
async function jupQuote({ inputMint, outputMint, amountLamports, slippageBps }) {
  const url = new URL('https://quote-api.jup.ag/v6/quote');
  url.searchParams.set('inputMint', inputMint);
  url.searchParams.set('outputMint', outputMint);
  url.searchParams.set('amount', String(amountLamports));
  url.searchParams.set('slippageBps', String(slippageBps));
  url.searchParams.set('onlyDirectRoutes', 'false');
  url.searchParams.set('asLegacyTransaction', 'false');

  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`Jupiter quote ${res.status}`);
  const data = await res.json();
  if (!data?.data?.length) throw new Error('No route');
  return data;
}
function priceFromQuote(q) {
  const r = q?.data?.[0];
  if (!r) return null;
  const inAmt = Number(r.inAmount) / (10 ** (r.inAmountDecimals ?? 9));
  const outAmt = Number(r.outAmount) / (10 ** (r.outAmountDecimals ?? 9));
  return inAmt / outAmt; // SOL per token
}
async function spotPriceFast(mint, { attempts = 8 } = {}) {
  const lamports = Math.floor(CFG.TRADE_SIZE_SOL * LAMPORTS_PER_SOL);
  const bps = Math.floor(CFG.MAX_SLIPPAGE * 10000);
  for (let i=0; i<attempts; i++) {
    try {
      const q = await jupQuote({
        inputMint: CFG.BASE_SOL_MINT,
        outputMint: mint,
        amountLamports: lamports,
        slippageBps: bps,
      });
      const px = priceFromQuote(q);
      if (px) return px;
    } catch {}
    await sleep(110);
  }
  return null;
}

// Récup décimales token via quote probe (SOL->TOKEN)
async function tokenDecimalsViaQuote(mint) {
  try {
    const q = await jupQuote({
      inputMint: CFG.BASE_SOL_MINT,
      outputMint: mint,
      amountLamports: Math.floor(0.01 * LAMPORTS_PER_SOL),
      slippageBps: Math.floor(CFG.MAX_SLIPPAGE * 10000),
    });
    return q?.data?.[0]?.outAmountDecimals ?? 9;
  } catch {
    return 9;
  }
}

// -------------------- GMGN Helpers --------------------
function gmgnRouteUrl({ tokenIn, tokenOut, inLamports, fromAddress, slippagePct, feeSol, antiMev }) {
  const base = `${CFG.GMGN_HOST}/defi/router/v1/sol/tx/get_swap_route`;
  const p = new URLSearchParams();
  p.set('token_in_address', tokenIn);
  p.set('token_out_address', tokenOut);
  p.set('in_amount', String(inLamports));
  p.set('from_address', fromAddress);
  p.set('slippage', String(slippagePct)); // GMGN attend 30 pour 30%
  if (antiMev) p.set('is_anti_mev', 'true');
  if (Number.isFinite(feeSol)) p.set('fee', String(feeSol));
  return `${base}?${p.toString()}`;
}

async function gmgnBuildAndSend({ tokenIn, tokenOut, inLamports, label='SWAP' }) {
  const slippagePct = Math.round(CFG.MAX_SLIPPAGE * 100);
  const url = gmgnRouteUrl({
    tokenIn, tokenOut,
    inLamports,
    fromAddress: WALLET_PK,
    slippagePct,
    feeSol: CFG.GMGN_FEE_SOL,
    antiMev: CFG.GMGN_ANTI_MEV,
  });

  const routeRes = await fetch(url);
  const route = await routeRes.json();
  if (!routeRes.ok || route?.code !== 0 || !route?.data?.raw_tx?.swapTransaction) {
    throw new Error(`GMGN route invalide: ${JSON.stringify(route)}`);
  }

  const raw = route.data.raw_tx;
  const swapTx = Buffer.from(raw.swapTransaction, 'base64');
  const vtx = VersionedTransaction.deserialize(swapTx);
  vtx.sign([wallet]);
  const signedTx = Buffer.from(vtx.serialize()).toString('base64');

  let send = await fetch(`${CFG.GMGN_HOST}/txproxy/v1/send_transaction`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chain: 'sol',
      signedTx,
      isAntiMev: !!CFG.GMGN_ANTI_MEV,
    }),
  });
  send = await send.json();
  const hash = send?.data?.hash;
  if (!hash) throw new Error(`GMGN send error: ${JSON.stringify(send)}`);

  info(`[${label}] sent GMGN  hash=${hash}`);
  return { hash, lastValidBlockHeight: raw.lastValidBlockHeight };
}

async function pollGmgnStatus({ hash, lastValidBlockHeight, label='SWAP', pollMs=800, maxMs=60_000 }) {
  const deadline = Date.now() + maxMs;
  while (true) {
    const url = `${CFG.GMGN_HOST}/defi/router/v1/sol/tx/get_transaction_status?hash=${hash}&last_valid_height=${lastValidBlockHeight}`;
    const r = await fetch(url);
    const j = await r.json();
    const s = j?.data || {};

    if (s.success) { info(`[${label}] ✅ confirmed`); return { ok:true, status:s, raw:j }; }
    if (s.failed)  { err(`[${label}] ❌ failed`, j);   return { ok:false, failed:true, status:s, raw:j }; }
    if (s.expired) { warn(`[${label}] ⏳ expired`, j); return { ok:false, expired:true, status:s, raw:j }; }

    // pending
    dbg(`[${label}] …pending`);
    if (Date.now() > deadline) {
      warn(`[${label}] ⏱️ local timeout while pending`);
      return { ok:false, timeout:true, status:s, raw:j };
    }
    await sleep(pollMs);
  }
}

// BUY SOL -> TOKEN via GMGN
async function gmgnBuy(mint) {
  const inLamports = Math.floor(CFG.TRADE_SIZE_SOL * LAMPORTS_PER_SOL);
  const { hash, lastValidBlockHeight } = await gmgnBuildAndSend({
    tokenIn: CFG.BASE_SOL_MINT,
    tokenOut: mint,
    inLamports,
    label: 'BUY',
  });
  const st = await pollGmgnStatus({ hash, lastValidBlockHeight, label:'BUY' });
  return { hash, status: st };
}

// SELL TOKEN -> SOL via GMGN (ExactIn en unités token)
async function gmgnSellExactToken(mint, tokenAmount) {
  const decimals = await tokenDecimalsViaQuote(mint);
  const inLamports = Math.max(1, Math.floor(tokenAmount * (10 ** decimals)));

  const { hash, lastValidBlockHeight } = await gmgnBuildAndSend({
    tokenIn: mint,
    tokenOut: CFG.BASE_SOL_MINT,
    inLamports,
    label: 'SELL',
  });
  const st = await pollGmgnStatus({ hash, lastValidBlockHeight, label:'SELL' });
  return { hash, status: st };
}

// -------------------- Extraction Helius payload --------------------
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
function estimateSolAdded(payload) {
  const solMint = CFG.BASE_SOL_MINT;
  const t = payload?.tokenTransfers || [];
  let by = 0;
  for (const x of t) if (x.mint === solMint && x.tokenAmount > 0) by += Number(x.tokenAmount);
  if (by > 0) return by;

  let lamports = 0;
  const top = payload?.transaction?.message?.instructions || [];
  const inner = payload?.meta?.innerInstructions || [];
  const scan = (ins) => { if (ins?.parsed?.type === 'transfer' && ins?.parsed?.info?.lamports) lamports += Number(ins.parsed.info.lamports); };
  top.forEach(scan);
  inner.forEach(g => (g.instructions || []).forEach(scan));
  return lamports / LAMPORTS_PER_SOL;
}

// -------------------- Gestion position --------------------
let position = null; // { mint, entry, sizeToken, high, remainingPct }

const TRAIL_GAP = Number(process.env.TRAIL_GAP || 0.15);
const TP1_PCT   = Number(process.env.TP1_PCT   || 0.40);
const TP1_SELL  = Number(process.env.TP1_SELL  || 0.70);
const HARD_SL   = Number(process.env.HARD_SL   || 0.35);
const EXIT_TIMEOUT_MS = Number(process.env.EXIT_TIMEOUT_MS || 15000);

const trailStopPrice = (p) => p.high * (1 - TRAIL_GAP);

async function liveSellPct(pct) {
  if (!position || pct <= 0) return;
  const sellAmount = position.sizeToken * pct;
  const { hash } = await gmgnSellExactToken(position.mint, sellAmount);
  const sold = Math.min(position.remainingPct, pct);
  position.remainingPct -= sold;
  position.sizeToken -= sellAmount;
  info(`🔴 [EXIT ${Math.round(pct*100)}%] hash=${hash}`);
  csv({ event:'exit', side:'SELL', token:position.mint, extra:`pct=${pct}|hash=${hash}` });

  if (position.sizeToken <= 1e-12 || position.remainingPct <= 1e-6) {
    position = null;
  }
}

async function managePositionLoop() {
  while (position) {
    const px = await spotPriceFast(position.mint).catch(()=>null) || position.entry;
    if (px > position.high) position.high = px;

    const up = px / position.entry - 1;
    const down = 1 - px / position.entry;

    if (position.remainingPct > 0.99 && up >= TP1_PCT) {
      await liveSellPct(TP1_SELL);
      position && (position.remainingPct = Math.max(0, position.remainingPct));
    }

    if (position && position.remainingPct <= 0.30) {
      const tstop = trailStopPrice(position);
      if (px <= tstop) {
        await liveSellPct(1.0);
        break;
      }
    }

    if (down >= HARD_SL) {
      await liveSellPct(1.0);
      break;
    }

    await sleep(150);
  }
}

// -------------------- BUY --------------------
async function liveBuy(mint) {
  // estimation du fill via quote
  let entryGuess = 0.000001;
  try {
    const q = await jupQuote({
      inputMint: CFG.BASE_SOL_MINT,
      outputMint: mint,
      amountLamports: Math.floor(CFG.TRADE_SIZE_SOL * LAMPORTS_PER_SOL),
      slippageBps: Math.floor(CFG.MAX_SLIPPAGE * 10000),
    });
    const px = priceFromQuote(q);
    if (px) entryGuess = px * (1 + 0.5 * CFG.MAX_SLIPPAGE);
  } catch {}

  const { hash } = await gmgnBuy(mint);

  // approx taille token pour gestion (pas utilisée pour l’achat lui-même)
  const sizeTok = CFG.TRADE_SIZE_SOL / entryGuess;

  position = {
    mint,
    entry: entryGuess,
    sizeToken: sizeTok,
    high: entryGuess,
    remainingPct: 1.0,
  };

  info(`🟢 [ENTER/GMGN] ${mint}  hash=${hash}  fill~${fmt(entryGuess)} SOL/tok`);
  csv({ event:'enter', side:'BUY', price:entryGuess, sol:CFG.TRADE_SIZE_SOL, token:mint, extra:`hash=${hash}` });

  managePositionLoop().catch(()=>{});

  if (EXIT_TIMEOUT_MS > 0) {
    setTimeout(async () => {
      if (position && position.mint === mint) {
        info(`⏳ Timeout ${EXIT_TIMEOUT_MS}ms => sortie totale`);
        await liveSellPct(1.0);
      }
    }, EXIT_TIMEOUT_MS);
  }
}

// -------------------- Webhook --------------------
const app = express();
app.use(bodyParser.json({ limit: '20mb' }));

const seenMint = new Map(); // anti-repeat 30s

app.post('/helius-webhook', async (req, res) => {
  try {
    const payload = Array.isArray(req.body) ? req.body[0] : req.body;
    const t = payload?.type || 'UNKNOWN';
    const src = payload?.source || 'unknown';

    if (!['CREATE_POOL','ADD_LIQUIDITY'].includes(t)) {
      dbg(`skip: ignored-type (${t})`);
      return res.status(200).send({ ok:true, note:'ignored-type', type:t });
    }

    const mint = extractMint(payload);
    if (!mint) { warn('skip: no-mint'); return res.status(200).send({ ok:true, note:'no-mint' }); }

    const added = estimateSolAdded(payload);
    info(`🚀 Nouveau token: ${mint} | type=${t} src=${src} | ~${fmt(added)} SOL ajoutés`);
    csv({ event:'detect', sol:added, token:mint, extra:`type=${t}|source=${src}` });

    if (added < CFG.TRIGGER_MIN_SOL) {
      dbg(`skip: below-threshold (${fmt(added)} < ${CFG.TRIGGER_MIN_SOL})`);
      return res.status(200).send({ ok:true, note:'below-threshold', added });
    }

    const now = Date.now();
    if (seenMint.get(mint) && now - seenMint.get(mint) < 30000) {
      return res.status(200).send({ ok:true, note:'cooldown' });
    }
    seenMint.set(mint, now);

    try {
      await liveBuy(mint);
      return res.status(200).send({ ok:true, triggered:true, mint, added });
    } catch (e) {
      err('Buy failed:', e.message);
      return res.status(200).send({ ok:true, note:'buy-failed', err:e.message });
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
  gmgn: { host: CFG.GMGN_HOST, antiMev: CFG.GMGN_ANTI_MEV, feeSol: CFG.GMGN_FEE_SOL },
  tp1: { pct: TP1_PCT, sell: TP1_SELL },
  trail: TRAIL_GAP,
  hardSL: HARD_SL,
  timeoutMs: EXIT_TIMEOUT_MS,
}));

app.listen(CFG.PORT, () => {
  info(`GMGN sniping listener on :${CFG.PORT} (LOG_LEVEL=${CFG.LOG_LEVEL})`);
});
