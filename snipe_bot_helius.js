/**
 * snipe_bot_helius.js  —  Webhook Helius -> checks -> (paper) trade simulé OU (live) exécution via executor-service
 *
 * Build: npm ci
 * Start: node snipe_bot_helius.js
 *
 * ENV principaux:
 *  MODE=paper|live
 *  RPC_URL=...
 *  JUPITER_QUOTE_URL=https://quote-api.jup.ag/v6/quote
 *  JUPITER_SWAP_URL=https://quote-api.jup.ag/v6/swap
 *  BASE_SOL_MINT=So11111111111111111111111111111111111111112
 *  TRADE_SIZE_SOL=0.15
 *  MAX_SLIPPAGE=0.30
 *  PRIORITY_FEE_SOL=0.008
 *  TP1_PCT=0.40
 *  TP1_SELL=0.70
 *  TRAIL_GAP=0.20
 *  HARD_SL=0.35
 *  POLL_MS=200
 *  LATENCY_MS=400
 *  AMM_FEE_RT=0.007
 *  CSV_FILE=paper_trades.csv
 *  MIN_LIQUIDITY_SOL=0.5
 *  MIN_TOPHOLDERS_PERCENT=30
 *  AMM_PROGRAM_IDS=comma,separated,programIds (Raydium/Orca/Pump.fun…)
 *  HELIUS_SECRET=   (HMAC)  OU  HELIUS_PUBLIC_KEY= (Ed25519 base58) — laisser vides pour tests
 *  EXECUTOR_URL=https://executor-xxx.onrender.com (requis en live)
 *  SKIP_ONCHAIN=1 pour bypass on-chain checks en tests
 *  ONCHAIN_SOFT_FAIL=1 pour passer en douceur si RPC renvoie une erreur
 *  LOG_LEVEL=debug|info
 */

import 'dotenv/config';
import express from 'express';
import bodyParser from 'body-parser';
import crypto from 'crypto';
import nacl from 'tweetnacl';
import fetch from 'node-fetch';
import fs from 'fs';
import bs58 from 'bs58';
import {
  Connection,
  PublicKey,
  LAMPORTS_PER_SOL,
  VersionedTransaction,
  Keypair,
} from '@solana/web3.js';

// -------------------- Config --------------------
const PORT = Number(process.env.PORT || 3000);
const LOG_LEVEL = (process.env.LOG_LEVEL || 'info').toLowerCase();
const dbg = (...a) => { if (LOG_LEVEL === 'debug') console.log(...a); };

const CFG = {
  MODE: (process.env.MODE || 'paper').toLowerCase(), // 'paper' | 'live'
  RPC_URL: process.env.RPC_URL || 'https://api.mainnet-beta.solana.com',
  JUP_Q_URL: process.env.JUPITER_QUOTE_URL || 'https://quote-api.jup.ag/v6/quote',
  JUP_S_URL: process.env.JUPITER_SWAP_URL || 'https://quote-api.jup.ag/v6/swap',
  BASE_SOL_MINT: process.env.BASE_SOL_MINT || 'So11111111111111111111111111111111111111112',
  TRADE_SIZE_SOL: Number(process.env.TRADE_SIZE_SOL || 0.15),
  MAX_SLIPPAGE: Number(process.env.MAX_SLIPPAGE || 0.30),
  PRIORITY_FEE_SOL: Number(process.env.PRIORITY_FEE_SOL || 0.008),
  TP1_PCT: Number(process.env.TP1_PCT || 0.40),
  TP1_SELL: Number(process.env.TP1_SELL || 0.70),
  TRAIL_GAP: Number(process.env.TRAIL_GAP || 0.20),
  HARD_SL: Number(process.env.HARD_SL || 0.35),
  POLL_MS: Number(process.env.POLL_MS || 200),
  LATENCY_MS: Number(process.env.LATENCY_MS || 400),
  AMM_FEE_RT: Number(process.env.AMM_FEE_RT || 0.007),
  CSV_FILE: process.env.CSV_FILE || 'paper_trades.csv',
  MIN_LIQUIDITY_SOL: Number(process.env.MIN_LIQUIDITY_SOL || 0.5),
  MIN_TOPHOLDERS_PERCENT: Number(process.env.MIN_TOPHOLDERS_PERCENT || 30),
  AMM_PROGRAM_IDS: (process.env.AMM_PROGRAM_IDS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean),
  HELIUS_SECRET: process.env.HELIUS_SECRET || '',
  HELIUS_PUBLIC_KEY: process.env.HELIUS_PUBLIC_KEY || '',
  EXECUTOR_URL: process.env.EXECUTOR_URL || '', // requis en MODE=live
};

const connection = new Connection(CFG.RPC_URL, { commitment: 'confirmed' });

// -------------------- CSV logger --------------------
if (!fs.existsSync(CFG.CSV_FILE)) {
  fs.writeFileSync(CFG.CSV_FILE, 'time,event,side,price,sol,token,realized_pnl\n');
}
function csvLog(row) {
  const line = `${new Date().toISOString()},${row.event},${row.side || ''},${row.price || ''},${row.sol || ''},${row.token || ''},${row.pnl || ''}\n`;
  fs.appendFileSync(CFG.CSV_FILE, line);
}

// -------------------- Helpers --------------------
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// -------------------- Verify Helius signature --------------------
function verifyHelius(req, rawBody) {
  const sigHeader = req.headers['x-helius-signature'] || req.headers['x-helio-signature'];
  // Si pas de secret/public key configurés, on autorise (dev).
  if (!CFG.HELIUS_PUBLIC_KEY && !CFG.HELIUS_SECRET) return true;
  if (!sigHeader) return false;

  // Ed25519 (recommandé)
  if (CFG.HELIUS_PUBLIC_KEY) {
    try {
      const pub = bs58.decode(CFG.HELIUS_PUBLIC_KEY);
      const sig = bs58.decode(String(sigHeader));
      return nacl.sign.detached.verify(Buffer.from(rawBody), sig, pub);
    } catch (e) {
      console.warn('Ed25519 verify error:', e.message);
      return false;
    }
  }

  // HMAC-SHA256
  if (CFG.HELIUS_SECRET) {
    try {
      const hmac = crypto.createHmac('sha256', CFG.HELIUS_SECRET).update(rawBody).digest('hex');
      return hmac === String(sigHeader).toLowerCase();
    } catch (e) {
      console.warn('HMAC verify error:', e.message);
      return false;
    }
  }

  return false;
}

// -------------------- Jupiter helpers --------------------
async function jupQuote({ inputMint, outputMint, amount, slippageBps = 3000 }) {
  const url = new URL(CFG.JUP_Q_URL);
  url.searchParams.set('inputMint', inputMint);
  url.searchParams.set('outputMint', outputMint);
  url.searchParams.set('amount', String(amount));
  url.searchParams.set('slippageBps', String(slippageBps));
  url.searchParams.set('onlyDirectRoutes', 'false');
  url.searchParams.set('asLegacyTransaction', 'false');

  const res = await fetch(url, { headers: { 'accept': 'application/json' } });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Jupiter quote failed ${res.status} ${txt}`);
  }
  return res.json();
}
function priceFromQuote(q) {
  if (!q?.data?.[0]) return null;
  const r = q.data[0];
  const inAmt = Number(r.inAmount) / (10 ** (r.inAmountDecimals ?? 9));
  const outAmt = Number(r.outAmount) / (10 ** (r.outAmountDecimals ?? 9));
  return inAmt / outAmt; // SOL per TOKEN
}

// -------------------- PAPER trading core --------------------
let position = null; // { entry, sizeToken, high, remainingPct, tokenMint }

function trailStopPrice(pos) { return pos.high * (1 - CFG.TRAIL_GAP); }

async function getCurrentPrice(tokenMint) {
  const lamports = Math.floor(0.05 * LAMPORTS_PER_SOL);
  try {
    const q = await jupQuote({
      inputMint: CFG.BASE_SOL_MINT,
      outputMint: tokenMint,
      amount: lamports,
      slippageBps: Math.floor(CFG.MAX_SLIPPAGE * 10000),
    });
    return priceFromQuote(q) || position?.entry || 0.000001;
  } catch {
    return position?.entry || 0.000001;
  }
}

async function paperSell(pct) {
  if (!position) return;
  const sizeSell = position.sizeToken * pct;
  const estInLamports = Math.max(1, Math.floor((position.entry * sizeSell) * LAMPORTS_PER_SOL));
  let q = null; try {
    q = await jupQuote({ inputMint: position.tokenMint, outputMint: CFG.BASE_SOL_MINT, amount: estInLamports, slippageBps: Math.floor(CFG.MAX_SLIPPAGE * 10000) });
  } catch {}
  const px = priceFromQuote(q) || position.entry;
  const pxFill = px * (1 - CFG.MAX_SLIPPAGE * 0.5);
  const proceedsSOL = sizeSell * pxFill * (1 - CFG.AMM_FEE_RT) - CFG.PRIORITY_FEE_SOL;
  const costBasisSOL = sizeSell * position.entry;
  const pnl = proceedsSOL - costBasisSOL;
  position.sizeToken -= sizeSell;
  csvLog({ event: 'paper_sell', side: 'SELL', price: pxFill, sol: proceedsSOL, token: sizeSell, pnl });
  console.log(`[PAPER SELL] price=${pxFill} sold=${sizeSell} proceedsSOL≈${proceedsSOL} pnl≈${pnl}`);
  if (position.sizeToken <= 1e-12) position = null;
}

async function managePositionLoop() {
  if (!position) return;
  const p = await getCurrentPrice(position.tokenMint);
  if (!p) return setTimeout(managePositionLoop, CFG.POLL_MS);
  if (p > position.high) position.high = p;
  const up = p / position.entry - 1;
  const down = 1 - p / position.entry;

  if (position.remainingPct > 0.99 && up >= CFG.TP1_PCT) {
    await paperSell(CFG.TP1_SELL);
    position.remainingPct = 1 - CFG.TP1_SELL;
  }
  if (position.remainingPct <= 0.30) {
    const tstop = trailStopPrice(position);
    if (p <= tstop) { await paperSell(1.0); return; }
  }
  if (down >= CFG.HARD_SL) { await paperSell(1.0); return; }
  setTimeout(managePositionLoop, CFG.POLL_MS);
}

async function paperBuy(tokenMint) {
  await sleep(CFG.LATENCY_MS);
  const lamports = Math.floor(CFG.TRADE_SIZE_SOL * LAMPORTS_PER_SOL);
  let q = null; try {
    q = await jupQuote({ inputMint: CFG.BASE_SOL_MINT, outputMint: tokenMint, amount: lamports, slippageBps: Math.floor(CFG.MAX_SLIPPAGE * 10000) });
  } catch {}
  const px = priceFromQuote(q) || (0.000001 + Math.random() * 0.000001);
  const pxFill = px * (1 + CFG.MAX_SLIPPAGE * 0.5);
  const sizeToken = CFG.TRADE_SIZE_SOL / pxFill;
  position = { entry: pxFill, sizeToken, high: pxFill, remainingPct: 1.0, tokenMint };
  const totalCost = CFG.TRADE_SIZE_SOL * (1 + CFG.AMM_FEE_RT) + CFG.PRIORITY_FEE_SOL;
  csvLog({ event: 'paper_buy', side: 'BUY', price: pxFill, sol: totalCost, token: sizeToken });
  console.log(`[PAPER BUY] ${tokenMint} price=${pxFill} tokens=${sizeToken} costSOL≈${totalCost}`);
  managePositionLoop();
}

// -------------------- On-chain checks & AMM filter --------------------
async function onChainChecks(mintAddress) {
  if (process.env.SKIP_ONCHAIN === '1') return { ok: true, info: { bypass: true } };
  try {
    const mintPub = new PublicKey(mintAddress);
    const mintAcct = await connection.getParsedAccountInfo(mintPub, 'confirmed');
    const mintData = mintAcct.value?.data?.parsed?.info;
    const freeze = mintData?.freezeAuthority || null;
    const mintAuth = mintData?.mintAuthority || null;
    const supply = Number(mintData?.supply || 0);

    let topPct = 0;
    try {
      const largest = await connection.getTokenLargestAccounts(mintPub);
      const arr = largest.value || [];
      if (arr.length) {
        const topAmt = Number(arr[0].amount || 0);
        const supplyNum = Number(supply || 0) || 1;
        topPct = topAmt / supplyNum * 100;
      }
    } catch (e) {
      if (process.env.ONCHAIN_SOFT_FAIL !== '0') {
        console.warn('largestAccounts unavailable → soft pass:', e.message);
        return { ok: true, info: { soft: true, reason: e.message } };
      }
      return { ok: false, reason: 'largestAccounts error: ' + e.message };
    }

    if (topPct > (100 - CFG.MIN_TOPHOLDERS_PERCENT)) return { ok: false, reason: `Top holder ${topPct.toFixed(2)}%` };
    if (mintAuth) return { ok: false, reason: `Mint authority present (${mintAuth})` };
    if (freeze) return { ok: false, reason: `Freeze authority present (${freeze})` };

    return { ok: true, info: { supply, topPct, freeze, mintAuth } };
  } catch (e) {
    console.warn('onChainChecks error', e.message);
    if (process.env.ONCHAIN_SOFT_FAIL !== '0') {
      return { ok: true, info: { soft: true, error: e.message } };
    }
    return { ok: false, reason: 'onChainChecks failure: ' + e.message };
  }
}

function txTouchesKnownAMMPrograms(payload) {
  // si pas de filtre configuré -> tout passe
  if (!CFG.AMM_PROGRAM_IDS.length) return true;

  // si Helius catégorise l'event comme AMM/pool, on accepte
  if (payload?.type && ['SWAP', 'ADD_LIQUIDITY', 'REMOVE_LIQUIDITY', 'WITHDRAW_LIQUIDITY', 'CREATE_POOL', 'LIQUIDITY_ADD', 'LIQUIDITY_REMOVE', 'SYNC_LIQUIDITY', 'ADMIN_SYNC_LIQUIDITY'].includes(payload.type)) {
    return true;
  }

  const programs = new Set(CFG.AMM_PROGRAM_IDS);
  const msgIns = payload?.transaction?.message?.instructions || [];
  const inner = payload?.meta?.innerInstructions || [];
  const keys = payload?.transaction?.message?.accountKeys || [];
  const seen = new Set();

  const addSeen = (ins) => {
    if (ins.programId) seen.add(String(ins.programId));
    if (ins.programIdIndex !== undefined && keys[ins.programIdIndex]) {
      seen.add(String(keys[ins.programIdIndex]));
    }
  };

  msgIns.forEach(addSeen);
  inner.forEach(g => (g.instructions || []).forEach(addSeen));

  const arr = Array.from(seen);
  dbg('AMM filter seen =>', arr);
  return arr.some(p => programs.has(p));
}

// -------------------- Extract mint & liquidity heuristics --------------------
function extractCandidateMintViaBalances(tx) {
  const pre = tx?.meta?.preTokenBalances || [];
  const post = tx?.meta?.postTokenBalances || [];
  const deltaByMint = {};
  for (const p of post) {
    const mint = p.mint;
    const postAmt = Number(p.uiTokenAmount?.uiAmount || 0);
    const preEntry = pre.find(x => x.accountIndex === p.accountIndex);
    const preAmt = preEntry ? Number(preEntry.uiTokenAmount?.uiAmount || 0) : 0;
    const delta = postAmt - preAmt;
    deltaByMint[mint] = (deltaByMint[mint] || 0) + delta;
  }
  const candidates = Object.entries(deltaByMint).filter(([m, d]) => d > 0).sort((a, b) => b[1] - a[1]);
  return candidates.length ? candidates[0][0] : null;
}

// NEW: enhanced extraction using Helius events + fallbacks
function extractCandidateMintEnhanced(tx) {
  const ev = tx?.events || {};
  const mints = new Set();

  if (ev.swap?.tokenA?.mint) mints.add(ev.swap.tokenA.mint);
  if (ev.swap?.tokenB?.mint) mints.add(ev.swap.tokenB.mint);

  if (ev.pool?.tokenA?.mint) mints.add(ev.pool.tokenA.mint);
  if (ev.pool?.tokenB?.mint) mints.add(ev.pool.tokenB.mint);

  if (ev.raydium?.tokenA?.mint) mints.add(ev.raydium.tokenA.mint);
  if (ev.raydium?.tokenB?.mint) mints.add(ev.raydium.tokenB.mint);

  if (ev.orca?.tokenA?.mint) mints.add(ev.orca.tokenA.mint);
  if (ev.orca?.tokenB?.mint) mints.add(ev.orca.tokenB.mint);

  for (const m of mints) {
    if (m && m !== CFG.BASE_SOL_MINT) return m;
  }

  const mintByDelta = extractCandidateMintViaBalances(tx);
  if (mintByDelta) return mintByDelta;

  const keys = tx?.transaction?.message?.accountKeys || [];
  const blacklist = new Set([
    '11111111111111111111111111111111',
    'SysvarRent111111111111111111111111111111111',
    'ComputeBudget111111111111111111111111111111',
    'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
    'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
  ]);
  for (const k of keys) {
    if (!k || blacklist.has(k)) continue;
    if (typeof k === 'string' && k.length >= 32) return k;
  }

  return null;
}

function estimateSOLAdded(tx) {
  let lamports = 0;
  const top = tx?.transaction?.message?.instructions || [];
  const inner = tx?.meta?.innerInstructions || [];
  const scan = (ins) => {
    if (ins.parsed?.type === 'transfer' && ins.parsed?.info?.lamports) {
      lamports += Number(ins.parsed.info.lamports);
    }
  };
  top.forEach(scan);
  inner.forEach(g => (g.instructions || []).forEach(scan));
  return lamports / LAMPORTS_PER_SOL;
}

// -------------------- Simulate Jupiter swap (anti-honeypot) --------------------
async function buildSwapTransactionBase64(tokenMint) {
  const lamports = Math.floor(CFG.TRADE_SIZE_SOL * LAMPORTS_PER_SOL);
  const quote = await jupQuote({
    inputMint: CFG.BASE_SOL_MINT,
    outputMint: tokenMint,
    amount: lamports,
    slippageBps: Math.floor(CFG.MAX_SLIPPAGE * 10000),
  });
  if (!quote?.data?.length) throw new Error('No route from Jupiter');

  const fake = Keypair.generate();
  const body = {
    quoteResponse: quote,
    userPublicKey: fake.publicKey.toBase58(),
    wrapAndUnwrapSOL: true,
    prioritizationFeeLamports: Math.max(0, Math.floor(CFG.PRIORITY_FEE_SOL * LAMPORTS_PER_SOL)),
  };
  const res = await fetch(CFG.JUP_S_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`swap build fail: ${txt}`);
  }
  const data = await res.json();
  if (!data?.swapTransaction) throw new Error('no swapTransaction in response');
  return data.swapTransaction; // base64
}

async function simulateJupiterSwapBase64(swapTransactionBase64) {
  const buf = Buffer.from(swapTransactionBase64, 'base64');
  const vtx = VersionedTransaction.deserialize(buf);
  const fake = Keypair.generate();
  vtx.sign([fake]);
  const sim = await connection.simulateTransaction(vtx, { sigVerify: false });
  if (sim?.value?.err) {
    throw new Error('simulateTransaction error: ' + JSON.stringify(sim.value.err));
  }
  return true;
}

// -------------------- Live executor client --------------------
async function execBuyViaHotExecutor({ swapTransactionBase64 }) {
  if (!CFG.EXECUTOR_URL) throw new Error('Missing EXECUTOR_URL in env for live mode');
  const res = await fetch(`${CFG.EXECUTOR_URL}/buy`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ swapTransactionBase64 }),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Executor error ${res.status}: ${txt}`);
  }
  return res.json(); // { ok, results, sig }
}

// -------------------- Express server --------------------
const app = express();
app.use(bodyParser.json({
  limit: '1mb',
  verify: (req, _res, buf) => { req.rawBody = buf; },
}));

app.get('/health', (_req, res) => res.send({ ok: true, mode: CFG.MODE }));

app.post('/helius-webhook', async (req, res) => {
  try {
    if (!verifyHelius(req, req.rawBody)) {
      return res.status(401).send({ ok: false, error: 'Invalid Helius signature' });
    }

    const payload = Array.isArray(req.body) ? req.body[0] : req.body;

    // Filtre AMM (si défini)
    if (!txTouchesKnownAMMPrograms(payload)) {
      dbg('AMM filter: skip (no known AMM program / type)');
      dbg('AMM filter skip → seen:', [payload?.type]);
      return res.status(200).send({ ok: true, note: 'amm-filter-skip' });
    }

    // Détection mint & liquidité
    const mint = extractCandidateMintEnhanced(payload);
    if (!mint) {
      dbg('No candidate mint found (type:', payload?.type, ')');
      return res.status(200).send({ ok: true, note: 'no-mint' });
    }

    const solAdded = estimateSOLAdded(payload);
    const isCreatePool = (payload?.type === 'CREATE_POOL');
    if (!isCreatePool && solAdded < CFG.MIN_LIQUIDITY_SOL) {
      return res.status(200).send({ ok: true, note: 'low-liquidity', solAdded });
    }

    // Checks on-chain
    const checks = await onChainChecks(mint);
    if (!checks.ok) {
      csvLog({ event: 'rejected', side: 'CHECK_FAIL', token: mint, pnl: checks.reason });
      return res.status(200).send({ ok: true, note: 'chain-check-fail', reason: checks.reason });
    }

    // Déclenchement final
    if (CFG.MODE === 'live') {
      // LIVE → Jupiter obligatoire
      let swapB64;
      try {
        swapB64 = await buildSwapTransactionBase64(mint);
        await simulateJupiterSwapBase64(swapB64);
      } catch (e) {
        console.log('simulate/build fail:', e.message);
        return res.status(200).send({ ok: true, note: 'simulate-fail', err: e.message });
      }
      console.log('LIVE mode -> sending to executor…');
      csvLog({ event: 'trigger', side: 'LIVE_BUY', token: mint, sol: CFG.TRADE_SIZE_SOL });
      try {
        const execRes = await execBuyViaHotExecutor({ swapTransactionBase64: swapB64 });
        console.log('Executor response:', execRes);
        return res.status(200).send({ ok: true, note: 'live-triggered', mint, solAdded, exec: execRes });
      } catch (e) {
        console.error('Live buy failed:', e.message);
        return res.status(500).send({ ok: false, error: e.message });
      }
    } else {
      // PAPER → pas d'appel Jupiter
      csvLog({ event: 'trigger', side: 'BUY', token: mint, sol: CFG.TRADE_SIZE_SOL });
      await paperBuy(mint);
      return res.status(200).send({ ok: true, note: 'paper-triggered', mint, solAdded });
    }

  } catch (e) {
    console.error('webhook error:', e);
    res.status(500).send({ ok: false, error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`Webhook listener on :${PORT} — mode=${CFG.MODE}`);
});
