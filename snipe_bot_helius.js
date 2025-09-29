/**
 * Snipe webhook -> entrée auto si add_liquidity >= seuil puis scalp 0.15 SOL
 * Paper trading par défaut (MODE=paper). Log CSV + console.
 *
 * ENV clefs:
 *  MODE=paper|live
 *  PORT=10000
 *  RPC_URL=...
 *  BASE_SOL_MINT=So11111111111111111111111111111111111111112
 *  TRIGGER_MIN_SOL=200
 *  TRADE_SIZE_SOL=0.15
 *  MAX_SLIPPAGE=0.30
 *  PRIORITY_FEE_SOL=0.008
 *  TP1_PCT=0.40
 *  TP1_SELL=0.70
 *  TRAIL_GAP=0.15
 *  HARD_SL=0.35
 *  EXIT_TIMEOUT_MS=15000    // 0 pour désactiver
 *  JUPITER_QUOTE_URL=https://quote-api.jup.ag/v6/quote
 *  AMM_PROGRAM_IDS=comma,separated,programIds (optionnel)
 *  CSV_FILE=paper_trades.csv
 *  LOG_LEVEL=debug|info
 */

import 'dotenv/config';
import express from 'express';
import bodyParser from 'body-parser';
import fetch from 'node-fetch';
import fs from 'fs';
import {
  Connection,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';

// -------------------- Config --------------------
const CFG = {
  MODE: (process.env.MODE || 'paper').toLowerCase(), // 'paper' | 'live'
  PORT: Number(process.env.PORT || 10000),
  RPC_URL: process.env.RPC_URL || 'https://api.mainnet-beta.solana.com',
  BASE_SOL_MINT: process.env.BASE_SOL_MINT || 'So11111111111111111111111111111111111111112',

  // Déclencheur
  TRIGGER_MIN_SOL: Number(process.env.TRIGGER_MIN_SOL || 200),

  // Trade params
  TRADE_SIZE_SOL: Number(process.env.TRADE_SIZE_SOL || 0.15),
  MAX_SLIPPAGE: Number(process.env.MAX_SLIPPAGE || 0.30),
  PRIORITY_FEE_SOL: Number(process.env.PRIORITY_FEE_SOL || 0.008),

  TP1_PCT: Number(process.env.TP1_PCT || 0.40),
  TP1_SELL: Number(process.env.TP1_SELL || 0.70),
  TRAIL_GAP: Number(process.env.TRAIL_GAP || 0.15),
  HARD_SL: Number(process.env.HARD_SL || 0.35),

  // Mettre 0 pour désactiver la sortie forcée
  EXIT_TIMEOUT_MS: Number(process.env.EXIT_TIMEOUT_MS || 15000),

  // Jupiter
  JUP_Q_URL: process.env.JUPITER_QUOTE_URL || 'https://quote-api.jup.ag/v6/quote',

  // AMM whitelist optionnelle
  AMM_PROGRAM_IDS: (process.env.AMM_PROGRAM_IDS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean),

  CSV_FILE: process.env.CSV_FILE || 'paper_trades.csv',
};

const connection = new Connection(CFG.RPC_URL, { commitment: 'confirmed' });

// CSV boot
if (!fs.existsSync(CFG.CSV_FILE)) {
  fs.writeFileSync(CFG.CSV_FILE, 'time,event,side,price,sol,token,extra\n');
}
const csv = (r) => {
  const line = `${new Date().toISOString()},${r.event},${r.side||''},${r.price||''},${r.sol||''},${r.token||''},${r.extra||''}\n`;
  fs.appendFileSync(CFG.CSV_FILE, line);
};

// -------------------- Utils --------------------
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const fmt = (n) => Number(n).toFixed(6);

// Récup prix spot via Jupiter (si route dispo). amount = lamports input.
async function jupSpotPrice({ inputMint, outputMint, amountLamports, slippageBps }) {
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
  const r = data?.data?.[0];
  if (!r) throw new Error('No route');
  const inAmt = Number(r.inAmount) / (10 ** (r.inAmountDecimals ?? 9));
  const outAmt = Number(r.outAmount) / (10 ** (r.outAmountDecimals ?? 9));
  // SOL per TOKEN
  return inAmt / outAmt;
}

// -------------------- Extraction depuis le payload Helius --------------------

// 1) Mint candidat: on prend le mint qui a été crédité côté pool (post > pre)
function extractMint(payload) {
  // Format "enhanced" => accountData[].tokenBalanceChanges
  const acc = payload?.accountData || [];
  const deltas = new Map();
  for (const a of acc) {
    for (const t of (a.tokenBalanceChanges || [])) {
      const mint = t.mint;
      const raw = Number(t.rawTokenAmount?.tokenAmount || 0);
      // On comptabilise seulement les crédits (raw > 0) vers des comptes non-user typés pool
      if (raw > 0) {
        deltas.set(mint, (deltas.get(mint) || 0) + raw / (10 ** (t.rawTokenAmount?.decimals ?? 9)));
      }
    }
  }
  if (deltas.size) {
    // mint le plus crédité
    return [...deltas.entries()].sort((a,b)=>b[1]-a[1])[0][0];
  }

  // fallback sur pre/post balances legacy
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

// 2) SOL ajoutés: try enhanced, sinon parse lamports des instructions
function estimateSolAdded(payload) {
  // Source enhanced: tokenTransfers SOL
  const solMint = CFG.BASE_SOL_MINT;
  const t = payload?.tokenTransfers || [];
  let by = 0;
  for (const x of t) {
    if (x.mint === solMint && x.tokenAmount > 0) by += Number(x.tokenAmount);
  }
  if (by > 0) return by;

  // fallback via inner parsed lamports
  let lamports = 0;
  const top = payload?.transaction?.message?.instructions || [];
  const inner = payload?.meta?.innerInstructions || [];
  const scan = (ins) => {
    const l = ins?.parsed?.info?.lamports;
    if (ins?.parsed?.type === 'transfer' && l) lamports += Number(l);
  };
  top.forEach(scan);
  inner.forEach(g => (g.instructions || []).forEach(scan));
  return lamports / LAMPORTS_PER_SOL;
}

// 3) Filtre AMM: si whitelist fournie
function ammAllowed(payload) {
  if (!CFG.AMM_PROGRAM_IDS.length) return true;
  const set = new Set(CFG.AMM_PROGRAM_IDS);

  // Enhanced: payload.programId + type
  if (payload?.programId && set.has(String(payload.programId))) return true;

  // Legacy: via accountKeys/programIdIndex
  const keys = payload?.transaction?.message?.accountKeys || [];
  const addrs = new Set();
  // top
  for (const ins of (payload?.transaction?.message?.instructions || [])) {
    if (ins.programId) addrs.add(String(ins.programId));
    if (ins.programIdIndex !== undefined && keys[ins.programIdIndex]) {
      addrs.add(String(keys[ins.programIdIndex]));
    }
  }
  // inner
  for (const grp of (payload?.meta?.innerInstructions || [])) {
    for (const ins of (grp.instructions || [])) {
      if (ins.programId) addrs.add(String(ins.programId));
      if (ins.programIdIndex !== undefined && keys[ins.programIdIndex]) {
        addrs.add(String(keys[ins.programIdIndex]));
      }
    }
  }
  for (const a of addrs) if (set.has(a)) return true;
  return false;
}

// -------------------- Paper trading (entrée <-> sortie en 15s max) --------------------
let openPos = null; // { mint, entry, sizeToken, high, remainingPct, startedAt }

function trailStopPrice(p) { return p.high * (1 - CFG.TRAIL_GAP); }

async function spotPriceOrFallback(mint, fallback) {
  const lamports = Math.floor(CFG.TRADE_SIZE_SOL * LAMPORTS_PER_SOL);
  const bps = Math.floor(CFG.MAX_SLIPPAGE * 10000);
  for (let i=0; i<5; i++) {
    try {
      const px = await jupSpotPrice({
        inputMint: CFG.BASE_SOL_MINT,
        outputMint: mint,
        amountLamports: lamports,
        slippageBps: bps,
      });
      return px;
    } catch {
      await sleep(250); // Jupiter pas prêt => on réessaie vite
    }
  }
  return fallback; // on utilise l’estimation d’entrée
}

async function paperEnter(mint, entryGuessSOLPerToken) {
  const px = await spotPriceOrFallback(mint, entryGuessSOLPerToken);
  const fill = px * (1 + 0.5 * CFG.MAX_SLIPPAGE);
  const sizeToken = CFG.TRADE_SIZE_SOL / fill;

  openPos = {
    mint,
    entry: fill,
    sizeToken,
    high: fill,
    remainingPct: 1.0,
    startedAt: Date.now(),
  };

  const estCost = CFG.TRADE_SIZE_SOL + CFG.PRIORITY_FEE_SOL;
  console.log(`🟢 [ENTER] ${mint} @ ${fmt(fill)} SOL/token | size=${fmt(sizeToken)} tok`);
  csv({ event:'enter', side:'BUY', price:fill, sol:estCost, token:sizeToken, extra:mint });

  // boucle de gestion (TP/SL/trailing) + timeout dur (optionnel)
  managePositionLoop().catch(()=>{});
  if (CFG.EXIT_TIMEOUT_MS > 0) {
    setTimeout(() => {
      if (openPos) {
        console.log(`⏳ Timeout ${CFG.EXIT_TIMEOUT_MS}ms -> close remaining`);
        paperExit(1.0).catch(()=>{});
      }
    }, CFG.EXIT_TIMEOUT_MS);
  }
}

async function paperExit(pct) {
  if (!openPos) return;
  const sellTok = openPos.sizeToken * pct;
  const mark = await spotPriceOrFallback(openPos.mint, openPos.entry);
  const fill = mark * (1 - 0.5 * CFG.MAX_SLIPPAGE);
  const proceedsSOL = sellTok * fill - CFG.PRIORITY_FEE_SOL;
  const costSOL = sellTok * openPos.entry;
  const pnl = proceedsSOL - costSOL;

  openPos.sizeToken -= sellTok;
  console.log(`🔴 [EXIT] ${openPos.mint} sell=${fmt(sellTok)} @ ${fmt(fill)} => pnl=${fmt(pnl)} SOL`);
  csv({ event:'exit', side:'SELL', price:fill, sol:proceedsSOL, token:sellTok, extra:`pnl=${pnl}` });

  if (openPos.sizeToken <= 1e-12) openPos = null;
}

async function managePositionLoop() {
  while (openPos) {
    const mark = await spotPriceOrFallback(openPos.mint, openPos.entry);
    if (mark > openPos.high) openPos.high = mark;

    const up = mark / openPos.entry - 1;
    const down = 1 - mark / openPos.entry;

    // TP1: +40% => vend 70%
    if (openPos.remainingPct > 0.99 && up >= CFG.TP1_PCT) {
      await paperExit(CFG.TP1_SELL);
      openPos.remainingPct = 1 - CFG.TP1_SELL;
    }

    // trailing sur le reste
    if (openPos.remainingPct <= 0.30 && mark <= trailStopPrice(openPos)) {
      await paperExit(1.0);
      break;
    }

    // SL dur
    if (down >= CFG.HARD_SL) {
      await paperExit(1.0);
      break;
    }

    await sleep(200); // loop rapide
  }
}

// -------------------- Webhook (robuste & verbeux) --------------------
const app = express();

// 1) parsers: JSON + fallback texte (si content-type non standard)
app.use(bodyParser.json({ limit: '25mb' }));              // batch Helius peut être lourd
app.use(bodyParser.text({ type: '*/*', limit: '25mb' })); // fallback si JSON échoue

// 2) trap d’erreur “too large” + log
app.use((err, req, res, next) => {
  if (err?.type === 'entity.too.large') {
    console.error('Body too large:', err.message);
    return res.status(413).send('Body too large');
  }
  next(err);
});

const LOG_DEBUG = (process.env.LOG_LEVEL || 'info').toLowerCase() === 'debug';
const seenMint = new Map(); // mint => ts

// util: parser robuste
function parseHeliusBody(req) {
  try {
    // cas normal: body déjà objet/array
    if (Array.isArray(req.body) || (req.body && typeof req.body === 'object')) {
      return req.body;
    }
    // fallback: body texte -> JSON.parse
    if (typeof req.body === 'string' && req.body.trim().length) {
      return JSON.parse(req.body);
    }
  } catch (e) {
    console.error('JSON parse error:', e.message);
  }
  return null;
}

app.post('/helius-webhook', async (req, res) => {
  // LOG: hit minimal
  const rawLen =
    typeof req.body === 'string'
      ? Buffer.byteLength(req.body, 'utf8')
      : Buffer.byteLength(JSON.stringify(req.body || ''), 'utf8');
  if (LOG_DEBUG) console.log(`[hit] /helius-webhook bodySize=${rawLen}B`);

  const parsed = parseHeliusBody(req);
  if (!parsed) {
    console.warn('Webhook hit but body is empty or unparsable');
    return res.status(400).send({ ok: false, error: 'unparsable-body' });
  }

  const batch = Array.isArray(parsed) ? parsed : [parsed];
  if (LOG_DEBUG) console.log(`[hit] batchLen=${batch.length}`);

  try {
    for (const payload of batch) {
      const t = payload?.type || 'UNKNOWN';
      const src = payload?.source || 'unknown';

      if (!['CREATE_POOL', 'ADD_LIQUIDITY'].includes(t)) {
        if (LOG_DEBUG) console.log(`skip: ignored-type (${t})`);
        continue;
      }

      if (!ammAllowed(payload)) {
        if (LOG_DEBUG) console.log('skip: amm-filter-skip');
        continue;
      }

      const mint = extractMint(payload);
      const added = estimateSolAdded(payload);
      const slot = payload?.slot;

      if (!mint) {
        if (LOG_DEBUG) console.log('skip: No candidate mint found');
        continue;
      }

      console.log(
        `🚀 Nouveau token détecté: ${mint} | type=${t}  source=${src} | ~${fmt(added)} SOL ajoutés`
      );
      csv({ event:'detect', side:'', price:'', sol:added, token:mint, extra:`type=${t}|source=${src}|slot=${slot}` });

      const now = Date.now();
      const last = seenMint.get(mint);
      if (last && now - last < 30000) {
        if (LOG_DEBUG) console.log(`cooldown: already seen ${mint} (${now - last}ms)`);
        continue;
      }
      seenMint.set(mint, now);

      if (added >= CFG.TRIGGER_MIN_SOL && CFG.MODE === 'paper') {
        const lamports = Math.floor(CFG.TRADE_SIZE_SOL * LAMPORTS_PER_SOL);
        let entryGuess = 0.000001;
        try {
          entryGuess = await jupSpotPrice({
            inputMint: CFG.BASE_SOL_MINT,
            outputMint: mint,
            amountLamports: lamports,
            slippageBps: Math.floor(CFG.MAX_SLIPPAGE * 10000),
          });
        } catch (e) {
          if (LOG_DEBUG) console.log(`quote miss (fallback) for ${mint}:`, e.message);
        }
        await paperEnter(mint, entryGuess);
        if (LOG_DEBUG) console.log(`triggered: paper enter ${mint} (added=${fmt(added)} SOL)`);
      } else {
        if (LOG_DEBUG) console.log(`logged: below trigger or not paper (added=${fmt(added)} SOL)`);
      }
    }

    return res.status(200).send({ ok: true });
  } catch (e) {
    console.error('webhook handler error:', e);
    return res.status(500).send({ ok: false, error: e.message });
  }
});

app.get('/health', (_req, res) =>
  res.send({ ok:true, mode: CFG.MODE, triggerMinSol: CFG.TRIGGER_MIN_SOL })
);

app.listen(CFG.PORT, () => {
  console.log(`Webhook listener on :${CFG.PORT} — mode=${CFG.MODE} (LOG_LEVEL=${process.env.LOG_LEVEL || 'info'})`);
});
