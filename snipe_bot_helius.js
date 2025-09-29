/**
 * Webhook Helius -> Achat live ultra-rapide (Jupiter + Helius Sender) -> TP/SL/Trailing
 * Logs VIVANTS pour comprendre chaque "skip".
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
  LAMPORTS_PER_SOL,
  VersionedTransaction,
  Keypair,
} from '@solana/web3.js';

// -------------------- Config --------------------
const CFG = {
  MODE: (process.env.MODE || 'live').toLowerCase(), // live only
  PORT: Number(process.env.PORT || 10000),
  RPC_URL: process.env.RPC_URL || 'https://api.mainnet-beta.solana.com',
  BASE_SOL_MINT: process.env.BASE_SOL_MINT || 'So11111111111111111111111111111111111111112',

  TRIGGER_MIN_SOL: Number(process.env.TRIGGER_MIN_SOL || 200),

  TRADE_SIZE_SOL: Number(process.env.TRADE_SIZE_SOL || 0.15),
  MAX_SLIPPAGE: Number(process.env.MAX_SLIPPAGE || 0.30), // 30%
  PRIORITY_FEE_SOL: Number(process.env.PRIORITY_FEE_SOL || 0.008),

  TP1_PCT: Number(process.env.TP1_PCT || 0.40),  // +40%
  TP1_SELL: Number(process.env.TP1_SELL || 0.70),// 70% sortis
  TRAIL_GAP: Number(process.env.TRAIL_GAP || 0.15), // 15%
  HARD_SL: Number(process.env.HARD_SL || 0.35),     // -35%
  EXIT_TIMEOUT_MS: Number(process.env.EXIT_TIMEOUT_MS || 15000), // 0 = off

  // Jupiter
  JUP_Q_URL: process.env.JUPITER_QUOTE_URL || 'https://quote-api.jup.ag/v6/quote',
  JUP_S_URL: process.env.JUPITER_SWAP_URL || 'https://quote-api.jup.ag/v6/swap',

  // Helius Sender (fast relay)
  HELIUS_SENDER_URL: process.env.HELIUS_SENDER_URL || '',

  // AMM allowlist
  AMM_PROGRAM_IDS: (process.env.AMM_PROGRAM_IDS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean),
  AMM_STRICT: ['1','true','yes'].includes(String(process.env.AMM_STRICT || '').toLowerCase()),

  // Wallet
  WALLET_SECRET_KEY: process.env.WALLET_SECRET_KEY || '', // base58

  CSV_FILE: process.env.CSV_FILE || 'live_trades.csv',
  LOG_LEVEL: (process.env.LOG_LEVEL || 'info').toLowerCase(),
};

const dbg  = (...a) => { if (CFG.LOG_LEVEL === 'debug') console.log(...a); };
const info = (...a) => console.log(...a);
const warn = (...a) => console.warn(...a);
const err  = (...a) => console.error(...a);

// Safety checks
if (!CFG.WALLET_SECRET_KEY) {
  err('❌ WALLET_SECRET_KEY manquant (base58).');
  process.exit(1);
}
if (!CFG.HELIUS_SENDER_URL) {
  err('❌ HELIUS_SENDER_URL manquant.');
  process.exit(1);
}

// -------------------- Setup --------------------
const connection = new Connection(CFG.RPC_URL, { commitment: 'processed' });
const wallet = Keypair.fromSecretKey(bs58.decode(CFG.WALLET_SECRET_KEY));
const WALLET_PK = wallet.publicKey.toBase58();

info(`▶️  Mode=${CFG.MODE}  LOG_LEVEL=${CFG.LOG_LEVEL}`);
info(`▶️  AMM_STRICT=${CFG.AMM_STRICT}  AMM_PROGRAM_IDS=[${CFG.AMM_PROGRAM_IDS.join(',')}]`);
info(`▶️  trigger>=${CFG.TRIGGER_MIN_SOL} SOL | trade=${CFG.TRADE_SIZE_SOL} SOL | fee=${CFG.PRIORITY_FEE_SOL} SOL`);

if (!fs.existsSync(CFG.CSV_FILE)) {
  fs.writeFileSync(CFG.CSV_FILE, 'time,event,side,price,sol,token,extra\n');
}
function csv(row) {
  const line = `${new Date().toISOString()},${row.event},${row.side||''},${row.price||''},${row.sol||''},${row.token||''},${row.extra||''}\n`;
  fs.appendFileSync(CFG.CSV_FILE, line);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const fmt = (n) => Number(n).toFixed(6);

// -------------------- Jupiter helpers --------------------
async function jupQuote({ inputMint, outputMint, amountLamports, slippageBps }) {
  const url = new URL(CFG.JUP_Q_URL);
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
  return inAmt / outAmt;
}

async function jupBuildSwapTxBase64({ quoteResponse, prioritizationFeeLamports }) {
  const body = {
    quoteResponse,
    userPublicKey: WALLET_PK,
    wrapAndUnwrapSOL: true,
    restrictIntermediateTokens: false,
    dynamicComputeUnitLimit: true,
    // priorité réseau
    prioritizationFeeLamports: Math.max(0, Math.floor(prioritizationFeeLamports || 0)),
  };
  const res = await fetch(CFG.JUP_S_URL, {
    method: 'POST',
    headers: { 'Content-Type':'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`swap build ${res.status}: ${t}`);
  }
  const data = await res.json();
  if (!data?.swapTransaction) throw new Error('no swapTransaction');
  return data.swapTransaction; // base64
}

async function signAndSendViaHelius(base64Tx) {
  // Désérialise & signe
  const buf = Buffer.from(base64Tx, 'base64');
  const vtx = VersionedTransaction.deserialize(buf);
  vtx.sign([wallet]);
  const raw = Buffer.from(vtx.serialize()).toString('base64');

  // Envoi Helius Sender
  const res = await fetch(CFG.HELIUS_SENDER_URL, {
    method: 'POST',
    headers: { 'Content-Type':'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'helius-snipe',
      method: 'sendTransaction',
      params: [raw, { encoding: 'base64', preflightCommitment: 'processed' }],
    }),
  });
  const data = await res.json();
  if (!data?.result) {
    throw new Error(`Helius sender error: ${JSON.stringify(data)}`);
  }
  return data.result; // signature
}

// -------------------- Price polling (pour TP/SL/Trailing) --------------------
async function spotPriceFast(mint, { attempts = 12 } = {}) {
  const lamports = Math.floor(CFG.TRADE_SIZE_SOL * LAMPORTS_PER_SOL);
  const bps = Math.floor(CFG.MAX_SLIPPAGE * 10000);
  for (let i = 0; i < attempts; i++) {
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
    await sleep(120); // agressif
  }
  return null;
}

// -------------------- AMM filter & extract helpers --------------------
function collectPrograms(payload) {
  const keys = payload?.transaction?.message?.accountKeys || [];
  const seen = new Set();
  if (payload?.programId) seen.add(String(payload.programId));

  for (const ins of (payload?.transaction?.message?.instructions || [])) {
    if (ins.programId) seen.add(String(ins.programId));
    if (ins.programIdIndex !== undefined && keys[ins.programIdIndex]) {
      seen.add(String(keys[ins.programIdIndex]));
    }
  }
  for (const grp of (payload?.meta?.innerInstructions || [])) {
    for (const ins of (grp.instructions || [])) {
      if (ins.programId) seen.add(String(ins.programId));
      if (ins.programIdIndex !== undefined && keys[ins.programIdIndex]) {
        seen.add(String(keys[ins.programIdIndex]));
      }
    }
  }
  return [...seen];
}

function ammAllowed(payload) {
  if (!CFG.AMM_PROGRAM_IDS.length) {
    dbg('amm: allowlist empty -> pass');
    return true;
  }
  const seen = collectPrograms(payload);
  dbg('[amm] seen programs =>', JSON.stringify(seen));
  const allow = new Set(CFG.AMM_PROGRAM_IDS);
  const any = seen.some(p => allow.has(p));
  if (CFG.AMM_STRICT) {
    if (!any) dbg('skip: amm-filter-skip (STRICT; no match with allowlist)');
    return any;
  } else {
    if (!any) dbg('amm filter: fallback by type (non-strict)');
    return true; // non-strict -> on laisse passer
  }
}

// mint candidat: celui le plus crédité côté pool
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

  // fallback legacy
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

// -------------------- LIVE trading core --------------------
let position = null; // { mint, entry, sizeToken, high, remainingPct, startedAt }

function trailStopPrice(p) { return p.high * (1 - CFG.TRAIL_GAP); }

async function liveBuy(mint) {
  const lamports = Math.floor(CFG.TRADE_SIZE_SOL * LAMPORTS_PER_SOL);
  const bps = Math.floor(CFG.MAX_SLIPPAGE * 10000);

  // Quote avec réessais agressifs (route pas toujours dispo aux tous premiers slots)
  let quote;
  for (let i=0; i<14; i++) {
    try {
      quote = await jupQuote({ inputMint: CFG.BASE_SOL_MINT, outputMint: mint, amountLamports: lamports, slippageBps: bps });
      break;
    } catch (e) { await sleep(90); }
  }
  if (!quote) throw new Error('No route from Jupiter (buy)');

  const swapB64 = await jupBuildSwapTxBase64({
    quoteResponse: quote,
    prioritizationFeeLamports: Math.floor(CFG.PRIORITY_FEE_SOL * LAMPORTS_PER_SOL),
  });
  const sig = await signAndSendViaHelius(swapB64);
  info(`🟢 [ENTER TX SENT] ${sig}`);

  // Estimation de fill (prudente)
  const px = priceFromQuote(quote) || 0.000001;
  const fill = px * (1 + 0.5 * CFG.MAX_SLIPPAGE);
  const sizeToken = CFG.TRADE_SIZE_SOL / fill;

  position = { mint, entry: fill, sizeToken, high: fill, remainingPct: 1.0, startedAt: Date.now() };
  info(`🟢 [ENTER] ${mint} @ ${fmt(fill)} SOL/token | size=${fmt(sizeToken)} tok`);
  csv({ event:'enter', side:'BUY', price:fill, sol:CFG.TRADE_SIZE_SOL, token:sizeToken, extra:`sig=${sig}` });
}

async function liveSellPct(pct) {
  if (!position || pct <= 0) return;
  const sellTokenMint = position.mint;
  const sellSize = position.sizeToken * pct;

  // Récup décimales (via probe rapide)
  const probe = await jupQuote({
    inputMint: CFG.BASE_SOL_MINT,
    outputMint: sellTokenMint,
    amountLamports: Math.floor(0.01 * LAMPORTS_PER_SOL),
    slippageBps: Math.floor(CFG.MAX_SLIPPAGE * 10000),
  }).catch(() => null);

  let tokenDecimals = probe?.data?.[0]?.outAmountDecimals ?? 9;
  const tokenUnits = Math.max(1, Math.floor(sellSize * (10 ** tokenDecimals)));

  const sellQuote = await jupQuote({
    inputMint: sellTokenMint,
    outputMint: CFG.BASE_SOL_MINT,
    amountLamports: tokenUnits,
    slippageBps: Math.floor(CFG.MAX_SLIPPAGE * 10000),
  });

  const swapB64 = await jupBuildSwapTxBase64({
    quoteResponse: sellQuote,
    prioritizationFeeLamports: Math.floor(CFG.PRIORITY_FEE_SOL * LAMPORTS_PER_SOL),
  });

  const sig = await signAndSendViaHelius(swapB64);
  const px = priceFromQuote(sellQuote) || position.entry;
  const proceedsSOL = sellSize * (px * (1 - 0.5 * CFG.MAX_SLIPPAGE));
  const pnl = proceedsSOL - (sellSize * position.entry);

  position.sizeToken -= sellSize;
  info(`🔴 [EXIT TX SENT] ${sig} | sell=${fmt(sellSize)} tok @~${fmt(px)} SOL/tok, pnl≈${fmt(pnl)} SOL`);
  csv({ event:'exit', side:'SELL', price:px, sol:proceedsSOL, token:sellSize, extra:`sig=${sig}|pnl=${pnl}` });

  if (position.sizeToken <= 1e-12) position = null;
}

async function managePositionLoop() {
  while (position) {
    const px = await spotPriceFast(position.mint, { attempts: 6 }) || position.entry;
    if (px > position.high) position.high = px;

    const up = px / position.entry - 1;
    const down = 1 - px / position.entry;

    if (position.remainingPct > 0.99 && up >= CFG.TP1_PCT) {
      await liveSellPct(CFG.TP1_SELL);
      position && (position.remainingPct = 1 - CFG.TP1_SELL);
    }
    if (position && position.remainingPct <= 0.30) {
      const tstop = trailStopPrice(position);
      if (px <= tstop) { await liveSellPct(1.0); break; }
    }
    if (down >= CFG.HARD_SL) { await liveSellPct(1.0); break; }

    await sleep(130);
  }
}

// -------------------- Webhook --------------------
const app = express();

// body logs: size + batch length
app.use(bodyParser.json({ limit: '20mb' }));
app.use((err, req, res, next) => {
  if (err?.type === 'entity.too.large') {
    err('Body too large:', err.message);
    return res.status(413).send('Body too large');
  }
  next(err);
});
app.use((req, _res, next) => {
  if (req.path === '/helius-webhook') {
    const rawLen = Number(req.headers['content-length'] || 0);
    dbg(`[hit] ${req.path} bodySize=${rawLen}B`);
    if (Array.isArray(req.body)) dbg('[hit] batchLen=', req.body.length);
    else if (req.body) dbg('[hit] batchLen= 1');
  }
  next();
});

// anti double-fire
const seenMint = new Map(); // mint => ts

app.post('/helius-webhook', async (req, res) => {
  try {
    const payload = Array.isArray(req.body) ? req.body[0] : req.body;
    const t = payload?.type || 'UNKNOWN';
    const src = payload?.source || 'unknown';

    if (!['CREATE_POOL','ADD_LIQUIDITY'].includes(t)) {
      dbg(`skip: ignored-type (${t})`);
      return res.status(200).send({ ok:true, note:'ignored-type', type:t });
    }

    if (!ammAllowed(payload)) {
      return res.status(200).send({ ok:true, note:'amm-filter-skip', strict:CFG.AMM_STRICT, allow:CFG.AMM_PROGRAM_IDS });
    }

    const mint = extractMint(payload);
    if (!mint) {
      warn('skip: no-mint (no candidate mint found)');
      return res.status(200).send({ ok:true, note:'no-mint' });
    }

    const added = estimateSolAdded(payload);
    const slot = payload?.slot;
    info(`🚀 Nouveau token détecté: ${mint} | type=${t} source=${src} | ~${fmt(added)} SOL ajoutés`);
    csv({ event:'detect', sol:added, token:mint, extra:`type=${t}|source=${src}|slot=${slot}` });

    // Seuil
    if (added < CFG.TRIGGER_MIN_SOL) {
      dbg(`skip: below-threshold (${fmt(added)} < ${CFG.TRIGGER_MIN_SOL})`);
      return res.status(200).send({ ok:true, note:'below-threshold', added });
    }

    // cooldown
    const now = Date.now();
    if (seenMint.get(mint) && now - seenMint.get(mint) < 30000) {
      dbg('skip: cooldown (30s) for mint', mint);
      return res.status(200).send({ ok:true, note:'cooldown' });
    }
    seenMint.set(mint, now);

    // Entrée live
    try {
      await liveBuy(mint);
      managePositionLoop().catch(()=>{});
      if (CFG.EXIT_TIMEOUT_MS > 0) {
        setTimeout(async () => {
          if (position && position.mint === mint) {
            info(`⏳ Timeout ${CFG.EXIT_TIMEOUT_MS}ms => sortie totale`);
            await liveSellPct(1.0);
          }
        }, CFG.EXIT_TIMEOUT_MS);
      }
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
  amm: { strict: CFG.AMM_STRICT, allow: CFG.AMM_PROGRAM_IDS },
}));

app.listen(CFG.PORT, () => {
  info(`Mint listener running on :${CFG.PORT} (LOG_LEVEL=${CFG.LOG_LEVEL})`);
});
