/**
 * Webhook Helius -> Achat live ultra-rapide (Jupiter + Helius Sender) -> gestion TP/SL/Trailing
 * Objectif: entrer le plus vite possible sur les nouveaux tokens.
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
  MAX_SLIPPAGE: Number(process.env.MAX_SLIPPAGE || 0.30),
  PRIORITY_FEE_SOL: Number(process.env.PRIORITY_FEE_SOL || 0.008),

  TP1_PCT: Number(process.env.TP1_PCT || 0.40),
  TP1_SELL: Number(process.env.TP1_SELL || 0.70),
  TRAIL_GAP: Number(process.env.TRAIL_GAP || 0.15),
  HARD_SL: Number(process.env.HARD_SL || 0.35),
  EXIT_TIMEOUT_MS: Number(process.env.EXIT_TIMEOUT_MS || 15000), // 0 pour désactiver

  JUP_Q_URL: process.env.JUPITER_QUOTE_URL || 'https://quote-api.jup.ag/v6/quote',
  JUP_S_URL: process.env.JUPITER_SWAP_URL || 'https://quote-api.jup.ag/v6/swap',

  HELIUS_SENDER_URL: process.env.HELIUS_SENDER_URL || '',

  AMM_PROGRAM_IDS: (process.env.AMM_PROGRAM_IDS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean),

  WALLET_SECRET_KEY: process.env.WALLET_SECRET_KEY || '', // base58
  CSV_FILE: process.env.CSV_FILE || 'live_trades.csv',
  LOG_LEVEL: (process.env.LOG_LEVEL || 'info').toLowerCase(),
};

if (!CFG.WALLET_SECRET_KEY) {
  console.error('❌ WALLET_SECRET_KEY manquant (base58). Abandon.');
  process.exit(1);
}
if (!CFG.HELIUS_SENDER_URL) {
  console.error('❌ HELIUS_SENDER_URL manquant. Abandon.');
  process.exit(1);
}

// -------------------- Setup --------------------
const connection = new Connection(CFG.RPC_URL, { commitment: 'processed' });
const wallet = Keypair.fromSecretKey(bs58.decode(CFG.WALLET_SECRET_KEY));
const WALLET_PK = wallet.publicKey.toBase58();

if (!fs.existsSync(CFG.CSV_FILE)) {
  fs.writeFileSync(CFG.CSV_FILE, 'time,event,side,price,sol,token,extra\n');
}
function csv(row) {
  const line = `${new Date().toISOString()},${row.event},${row.side||''},${row.price||''},${row.sol||''},${row.token||''},${row.extra||''}\n`;
  fs.appendFileSync(CFG.CSV_FILE, line);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const fmt = (n) => Number(n).toFixed(6);
const dbg = (...a) => { if (CFG.LOG_LEVEL === 'debug') console.log(...a); };

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
    } catch (e) {
      // ignore
    }
    await sleep(150); // agressif
  }
  return null;
}

// -------------------- AMM filter & extract helpers --------------------
function ammAllowed(payload) {
  if (!CFG.AMM_PROGRAM_IDS.length) return true;
  const set = new Set(CFG.AMM_PROGRAM_IDS);
  if (payload?.programId && set.has(String(payload.programId))) return true;

  const keys = payload?.transaction?.message?.accountKeys || [];
  const addrs = new Set();
  for (const ins of (payload?.transaction?.message?.instructions || [])) {
    if (ins.programId) addrs.add(String(ins.programId));
    if (ins.programIdIndex !== undefined && keys[ins.programIdIndex]) addrs.add(String(keys[ins.programIdIndex]));
  }
  for (const grp of (payload?.meta?.innerInstructions || [])) {
    for (const ins of (grp.instructions || [])) {
      if (ins.programId) addrs.add(String(ins.programId));
      if (ins.programIdIndex !== undefined && keys[ins.programIdIndex]) addrs.add(String(keys[ins.programIdIndex]));
    }
  }
  for (const a of addrs) if (set.has(a)) return true;
  return false;
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

  // Quote (ré-essais agressifs jusqu’à route dispo)
  let quote;
  for (let i=0; i<12; i++) {
    try {
      quote = await jupQuote({ inputMint: CFG.BASE_SOL_MINT, outputMint: mint, amountLamports: lamports, slippageBps: bps });
      break;
    } catch { await sleep(120); }
  }
  if (!quote) throw new Error('No route from Jupiter (buy)');

  // Build + send
  const swapB64 = await jupBuildSwapTxBase64({
    quoteResponse: quote,
    prioritizationFeeLamports: Math.floor(CFG.PRIORITY_FEE_SOL * LAMPORTS_PER_SOL),
  });
  const sig = await signAndSendViaHelius(swapB64);
  console.log(`🟢 [ENTER TX SENT] ${sig}`);

  // prix d'entrée estimé depuis quote
  const px = priceFromQuote(quote) || 0;
  const fill = px * (1 + 0.5 * CFG.MAX_SLIPPAGE);
  const sizeToken = CFG.TRADE_SIZE_SOL / (fill || 1e-9);

  position = { mint, entry: fill || 0.000001, sizeToken, high: fill || 0.000001, remainingPct: 1.0, startedAt: Date.now() };
  csv({ event:'enter', side:'BUY', price:fill, sol:CFG.TRADE_SIZE_SOL, token:sizeToken, extra:`sig=${sig}` });
}

async function liveSellPct(pct) {
  if (!position || pct <= 0) return;
  const sellTokenMint = position.mint;
  const sellSize = position.sizeToken * pct;

  // Sortie: token -> SOL
  // Estimation de la quantité de token à convertir en amountLamports côté Jupiter:
  // On demande un inAmount en TOKEN *via Jupiter requires input in token's smallest units*,
  // mais l’API v6 accepte amount en base des décimales du "inputMint".
  // Ici on n’a pas les décimales on-chain sans RPC supplémentaire; on passe par un quote SOL->TOKEN
  // pour récupérer outAmountDecimals, puis on reconstruit inAmount pour la direction inverse.
  const probe = await jupQuote({
    inputMint: CFG.BASE_SOL_MINT,
    outputMint: sellTokenMint,
    amountLamports: Math.floor(0.01 * LAMPORTS_PER_SOL),  // petit probe
    slippageBps: Math.floor(CFG.MAX_SLIPPAGE * 10000),
  }).catch(() => null);

  let tokenDecimals = probe?.data?.[0]?.outAmountDecimals ?? 9;
  const tokenUnits = Math.max(1, Math.floor(sellSize * (10 ** tokenDecimals)));

  // quote pour vendre les tokens
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
  console.log(`🔴 [EXIT TX SENT] ${sig} | sell=${fmt(sellSize)} tok @~${fmt(px)} SOL/tok, pnl≈${fmt(pnl)} SOL`);
  csv({ event:'exit', side:'SELL', price:px, sol:proceedsSOL, token:sellSize, extra:`sig=${sig}|pnl=${pnl}` });

  if (position.sizeToken <= 1e-12) position = null;
}

async function managePositionLoop() {
  while (position) {
    const px = await spotPriceFast(position.mint, { attempts: 6 }) || position.entry;
    if (px > position.high) position.high = px;

    const up = px / position.entry - 1;
    const down = 1 - px / position.entry;

    // TP1
    if (position.remainingPct > 0.99 && up >= CFG.TP1_PCT) {
      await liveSellPct(CFG.TP1_SELL);
      position && (position.remainingPct = 1 - CFG.TP1_SELL);
    }

    // Trailing
    if (position && position.remainingPct <= 0.30) {
      const tstop = trailStopPrice(position);
      if (px <= tstop) {
        await liveSellPct(1.0);
        break;
      }
    }

    // Hard SL
    if (down >= CFG.HARD_SL) {
      await liveSellPct(1.0);
      break;
    }

    await sleep(150);
  }
}

// -------------------- Webhook --------------------
const app = express();
app.use(bodyParser.json({ limit: '20mb' }));
app.use((err, req, res, next) => {
  if (err?.type === 'entity.too.large') {
    console.error('Body too large:', err.message);
    return res.status(413).send('Body too large');
  }
  next(err);
});

const seenMint = new Map(); // anti-refire courte (30s)

app.post('/helius-webhook', async (req, res) => {
  try {
    const payload = Array.isArray(req.body) ? req.body[0] : req.body;
    const t = payload?.type || 'UNKNOWN';
    const src = payload?.source || 'unknown';

    if (!['CREATE_POOL','ADD_LIQUIDITY'].includes(t)) {
      return res.status(200).send({ ok:true, note:'ignored-type' });
    }

    if (!ammAllowed(payload)) {
      dbg('skip: amm-filter-skip');
      return res.status(200).send({ ok:true, note:'amm-filter-skip' });
    }

    const mint = extractMint(payload);
    const added = estimateSolAdded(payload);
    const slot = payload?.slot;

    if (!mint) {
      console.log('No candidate mint found');
      return res.status(200).send({ ok:true, note:'no-mint' });
    }

    console.log(`🚀 Nouveau token détecté: ${mint}  |  type=${t}  source=${src}  |  ~${fmt(added)} SOL ajoutés`);
    csv({ event:'detect', sol:added, token:mint, extra:`type=${t}|source=${src}|slot=${slot}` });

    const now = Date.now();
    if (seenMint.get(mint) && now - seenMint.get(mint) < 30000) {
      return res.status(200).send({ ok:true, note:'cooldown' });
    }
    seenMint.set(mint, now);

    if (added >= CFG.TRIGGER_MIN_SOL) {
      // Entrée live
      try {
        await liveBuy(mint);
        // Lance la boucle de gestion
        managePositionLoop().catch(()=>{});
        // Timeout forcé optionnel
        if (CFG.EXIT_TIMEOUT_MS > 0) {
          setTimeout(async () => {
            if (position && position.mint === mint) {
              console.log(`⏳ Timeout ${CFG.EXIT_TIMEOUT_MS}ms => sortie totale`);
              await liveSellPct(1.0);
            }
          }, CFG.EXIT_TIMEOUT_MS);
        }
        return res.status(200).send({ ok:true, triggered:true, mint, added });
      } catch (e) {
        console.error('Buy failed:', e.message);
        return res.status(200).send({ ok:true, note:'buy-failed', err:e.message });
      }
    }

    return res.status(200).send({ ok:true, note:'below-threshold', added });
  } catch (e) {
    console.error('webhook error:', e);
    return res.status(500).send({ ok:false, error: e.message });
  }
});

app.get('/health', (_req, res) => res.send({
  ok: true,
  mode: CFG.MODE,
  wallet: WALLET_PK,
  triggerMinSol: CFG.TRIGGER_MIN_SOL,
}));

app.listen(CFG.PORT, () => {
  console.log(`Mint listener running on :${CFG.PORT} (LOG_LEVEL=${CFG.LOG_LEVEL})`);
});
