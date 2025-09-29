/**
 * Sniper Pump.fun — trade-local only (buy & sell) + TP/SL/Trailing/Timeout
 * - Achats/Ventes via Pump Portal /api/trade-local (sign local, send via RPC)
 * - Estimation de prix via Jupiter Quote (pas de swap Jupiter)
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
} from '@solana/web3.js';

// ====================== Config ======================
const CFG = {
  MODE: (process.env.MODE || 'live').toLowerCase(),
  PORT: Number(process.env.PORT || 10000),
  RPC_URL: process.env.RPC_URL || 'https://api.mainnet-beta.solana.com',

  // Déclencheur min d’add_liquidity (en SOL) pour snip
  TRIGGER_MIN_SOL: Number(process.env.TRIGGER_MIN_SOL || 50),

  // Trade
  TRADE_SIZE_SOL: Number(process.env.TRADE_SIZE_SOL || 0.15),
  MAX_SLIPPAGE: Number(process.env.MAX_SLIPPAGE || 0.30), // 30% => 30
  PRIORITY_FEE_SOL: Number(process.env.PRIORITY_FEE_SOL || 0.008),

  // Strategy
  TP1_PCT: Number(process.env.TP1_PCT || 0.40),   // +40%
  TP1_SELL: Number(process.env.TP1_SELL || 0.70), // vend 70% sur TP1
  TRAIL_GAP: Number(process.env.TRAIL_GAP || 0.15), // stop suiveur 15% sous le plus haut
  HARD_SL: Number(process.env.HARD_SL || 0.35),     // -35% hard stop
  EXIT_TIMEOUT_MS: Number(process.env.EXIT_TIMEOUT_MS || 15000), // 0 pour désactiver

  // Pump Portal
  PUMP_TRADE_LOCAL_URL: process.env.PUMP_TRADE_LOCAL_URL || 'https://pumpportal.fun/api/trade-local',

  // Jupiter (quote only)
  JUP_Q_URL: process.env.JUPITER_QUOTE_URL || 'https://quote-api.jup.ag/v6/quote',
  BASE_SOL_MINT: 'So11111111111111111111111111111111111111112',

  // Wallet
  WALLET_SECRET_KEY: process.env.WALLET_SECRET_KEY || '', // base58

  // Divers
  CSV_FILE: process.env.CSV_FILE || 'live_trades.csv',
  LOG_LEVEL: (process.env.LOG_LEVEL || 'info').toLowerCase(),
};

const dbg  = (...a) => { if (CFG.LOG_LEVEL === 'debug') console.log(...a); };
const info = (...a) => console.log(...a);
const warn = (...a) => console.warn(...a);
const err  = (...a) => console.error(...a);

if (!CFG.WALLET_SECRET_KEY) { err('❌ WALLET_SECRET_KEY manquant'); process.exit(1); }

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

// ====================== Jupiter quote (prix uniquement) ======================
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
  // SOL per TOKEN
  return inAmt / outAmt;
}
async function spotPriceFast(mint, { attempts = 10 } = {}) {
  const lamports = Math.floor(CFG.TRADE_SIZE_SOL * LAMPORTS_PER_SOL);
  const bps = Math.floor(CFG.MAX_SLIPPAGE * 10000);
  for (let i=0;i<attempts;i++){
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
    await sleep(120);
  }
  return null;
}

// ====================== Pump Portal — trade-local ======================
async function pumpBuildAndSend(body) {
  const res = await fetch(CFG.PUMP_TRADE_LOCAL_URL, {
    method: 'POST',
    headers: { 'Content-Type':'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`pump trade-local ${res.status}: ${t} \nres:\n${JSON.stringify(res)} \nbody:\n${JSON.stringify(body)}`);
  }
  // réponse = tx sérialisée (buffer)
  const buf = new Uint8Array(await res.arrayBuffer());
  const vtx = VersionedTransaction.deserialize(buf);
  vtx.sign([wallet]);

  // envoi via RPC (préflight off pour max vitesse)
  const sig = await connection.sendTransaction(vtx, { skipPreflight: true });
  return sig;
}

async function pumpBuy(mint) {
  const body = {
    publicKey: WALLET_PK,
    action: 'buy',
    mint,
    amount: CFG.TRADE_SIZE_SOL,          // en SOL
    denominatedInSol: 'true',
    slippage: Math.round(CFG.MAX_SLIPPAGE * 100),
    priorityFee: CFG.PRIORITY_FEE_SOL,
    pool: 'auto',
  };
  return pumpBuildAndSend(body);
}

// pct ∈ (0,1]  — utilise le mode "pourcentage" natif de Pump Portal
async function pumpSellPct(mint, pct) {
  const percent = Math.max(1, Math.min(100, Math.round(pct * 100)));
  const body = {
    publicKey: WALLET_PK,
    action: 'sell',
    mint,
    amount: `${percent}%`,               // ex: "70%"
    denominatedInSol: 'false',           // amount est en tokens (ou en %)
    slippage: Math.round(CFG.MAX_SLIPPAGE * 100),
    priorityFee: CFG.PRIORITY_FEE_SOL,
    pool: 'auto',
  };
  return pumpBuildAndSend(body);
}

// ====================== Aide extraction (payload Helius) ======================
function extractMint(payload) {
  // essaye d'abord format "enhanced"
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

  // fallback legacy pre/post
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
  // fallback via inner 'transfer' lamports
  let lamports = 0;
  const top = payload?.transaction?.message?.instructions || [];
  const inner = payload?.meta?.innerInstructions || [];
  const scan = (ins) => { if (ins?.parsed?.type === 'transfer' && ins?.parsed?.info?.lamports) lamports += Number(ins.parsed.info.lamports); };
  top.forEach(scan);
  inner.forEach(g => (g.instructions || []).forEach(scan));
  return lamports / LAMPORTS_PER_SOL;
}

// ====================== Strategy State & Loop ======================
let position = null; // { mint, entry, high, remainingPct, startedAt }

const trailStopPrice = (p) => p.high * (1 - CFG.TRAIL_GAP);

async function liveSellPct(pct) {
  if (!position || pct <= 0) return;
  const sig = await pumpSellPct(position.mint, pct);
  const soldPct = Math.min(position.remainingPct, pct);
  position.remainingPct -= soldPct;
  info(`🔴 [EXIT ${Math.round(pct*100)}%] ${sig}`);
  csv({ event:'exit', side:'SELL', price:'', sol:'', token:position.mint, extra:`pct=${pct}|sig=${sig}` });

  if (position.remainingPct <= 0.000001) {
    position = null;
  }
}

async function managePositionLoop() {
  while (position) {
    // prix spot via Jupiter (quote-only)
    const px = await spotPriceFast(position.mint).catch(()=>null) || position.entry;
    if (px > position.high) position.high = px;

    const up = px / position.entry - 1;
    const down = 1 - px / position.entry;

    // TP1
    if (position.remainingPct > 0.99 && up >= CFG.TP1_PCT) {
      await liveSellPct(CFG.TP1_SELL);
      position && (position.remainingPct = Math.max(0, position.remainingPct));
    }

    // Trailing (sur le reste)
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

// ====================== BUY ======================
async function liveBuy(mint) {
  // Essaye d’estimer le px d’entrée via Jupiter (quote only)
  let entryGuess = 0.000001;
  try {
    const q = await jupQuote({
      inputMint: CFG.BASE_SOL_MINT,
      outputMint: mint,
      amountLamports: Math.floor(CFG.TRADE_SIZE_SOL * LAMPORTS_PER_SOL),
      slippageBps: Math.floor(CFG.MAX_SLIPPAGE * 10000),
    });
    const px = priceFromQuote(q);
    if (px) entryGuess = px * (1 + 0.5 * CFG.MAX_SLIPPAGE); // conservative fill
  } catch {}

  const sig = await pumpBuy(mint);
  position = {
    mint,
    entry: entryGuess,
    high: entryGuess,
    remainingPct: 1.0,
    startedAt: Date.now(),
  };

  info(`🟢 [ENTER/pump] ${mint}  sig=${sig}  fill~${fmt(entryGuess)} SOL/tok`);
  csv({ event:'enter', side:'BUY', price:entryGuess, sol:CFG.TRADE_SIZE_SOL, token:mint, extra:`sig=${sig}` });

  // start management
  managePositionLoop().catch(()=>{});

  // timeout total (optionnel)
  if (CFG.EXIT_TIMEOUT_MS > 0) {
    setTimeout(async () => {
      if (position && position.mint === mint) {
        info(`⏳ Timeout ${CFG.EXIT_TIMEOUT_MS}ms => sortie totale`);
        await liveSellPct(1.0);
      }
    }, CFG.EXIT_TIMEOUT_MS);
  }
}

// ====================== Webhook ======================
const app = express();
app.use(bodyParser.json({ limit: '20mb' }));

const seenMint = new Map(); // anti-refire 30s

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
    info(`🚀 Nouveau token détecté: ${mint} | type=${t} source=${src} | ~${fmt(added)} SOL ajoutés`);
    csv({ event:'detect', price:'', sol:added, token:mint, extra:`type=${t}|source=${src}` });

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
  tp1: { pct: CFG.TP1_PCT, sell: CFG.TP1_SELL },
  trail: CFG.TRAIL_GAP,
  hardSL: CFG.HARD_SL,
  timeoutMs: CFG.EXIT_TIMEOUT_MS,
}));

app.listen(CFG.PORT, () => {
  info(`Mint listener running on :${CFG.PORT} (LOG_LEVEL=${CFG.LOG_LEVEL})`);
});
