/**
 * Helius webhook -> détection pools + scalp paper
 * - Traite tableaux d'events
 * - AMM_STRICT=0 (par défaut) : accepte par type (CREATE_POOL/ADD_LIQUIDITY) même si whitelist ne matche pas
 * - AMM_STRICT=1 : refuse si program non whiteliste
 * - LOG_LEVEL=debug pour voir les programmes "vus"
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

/* ===================== Config ===================== */
const CFG = {
  MODE: (process.env.MODE || 'paper').toLowerCase(),      // paper | live
  PORT: Number(process.env.PORT || 10000),

  RPC_URL: process.env.RPC_URL || 'https://api.mainnet-beta.solana.com',
  BASE_SOL_MINT: process.env.BASE_SOL_MINT || 'So11111111111111111111111111111111111111112',

  // Déclencheur (min SOL ajoutés pour entrer)
  TRIGGER_MIN_SOL: Number(process.env.TRIGGER_MIN_SOL || 200),

  // Params “paper” (scalp)
  TRADE_SIZE_SOL: Number(process.env.TRADE_SIZE_SOL || 0.15),
  MAX_SLIPPAGE: Number(process.env.MAX_SLIPPAGE || 0.30),
  PRIORITY_FEE_SOL: Number(process.env.PRIORITY_FEE_SOL || 0.008),
  TP1_PCT: Number(process.env.TP1_PCT || 0.40),
  TP1_SELL: Number(process.env.TP1_SELL || 0.70),
  TRAIL_GAP: Number(process.env.TRAIL_GAP || 0.15),
  HARD_SL: Number(process.env.HARD_SL || 0.35),
  EXIT_TIMEOUT_MS: Number(process.env.EXIT_TIMEOUT_MS || 15000), // mettre 0 pour désactiver

  // Jupiter
  JUP_Q_URL: process.env.JUPITER_QUOTE_URL || 'https://quote-api.jup.ag/v6/quote',

  // Filtre AMM (whitelist) + sévérité
  AMM_PROGRAM_IDS: (process.env.AMM_PROGRAM_IDS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean),
  AMM_STRICT: Number(process.env.AMM_STRICT || 0),        // 0 = souple (fallback par type), 1 = strict

  // Logs
  LOG_LEVEL: (process.env.LOG_LEVEL || 'info').toLowerCase(),

  // CSV
  CSV_FILE: process.env.CSV_FILE || 'paper_trades.csv',
};

const connection = new Connection(CFG.RPC_URL, { commitment: 'confirmed' });

/* ===================== CSV ===================== */
if (!fs.existsSync(CFG.CSV_FILE)) {
  fs.writeFileSync(CFG.CSV_FILE, 'time,event,side,price,sol,token,extra\n');
}
const csv = (r) => {
  const line = `${new Date().toISOString()},${r.event},${r.side||''},${r.price||''},${r.sol||''},${r.token||''},${r.extra||''}\n`;
  fs.appendFileSync(CFG.CSV_FILE, line);
};

const dbg = (...a) => { if (CFG.LOG_LEVEL === 'debug') console.log(...a); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const fmt = (n) => Number(n).toFixed(6);

/* ===================== Jupiter ===================== */
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
  return inAmt / outAmt; // SOL per TOKEN
}

/* ===================== Extraction ===================== */
function extractMint(payload) {
  // 1) Helius enhanced: accountData[].tokenBalanceChanges[]
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
  if (deltas.size) {
    return [...deltas.entries()].sort((a,b)=>b[1]-a[1])[0][0];
  }

  // 2) Legacy: pre/post balances
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
  // Enhanced: tokenTransfers
  const solMint = CFG.BASE_SOL_MINT;
  const t = payload?.tokenTransfers || [];
  let by = 0;
  for (const x of t) {
    if (x.mint === solMint && Number(x.tokenAmount) > 0) by += Number(x.tokenAmount);
  }
  if (by > 0) return by;

  // Fallback: transfer lamports parsed
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

/* ===================== AMM filter ===================== */
function ammAllowedStrict(payload) {
  if (!CFG.AMM_PROGRAM_IDS.length) return true; // pas de whitelist => tout passe

  const set = new Set(CFG.AMM_PROGRAM_IDS);

  // Enhanced shortcut
  if (payload?.programId && set.has(String(payload.programId))) {
    dbg('[amm] match programId (enhanced):', payload.programId);
    return true;
  }

  // Legacy scan
  const keys = payload?.transaction?.message?.accountKeys || [];
  const seen = new Set();

  const addSeen = (ix) => {
    if (ix.programId) seen.add(String(ix.programId));
    if (ix.programIdIndex !== undefined && keys[ix.programIdIndex]) {
      seen.add(String(keys[ix.programIdIndex]));
    }
  };

  for (const ix of (payload?.transaction?.message?.instructions || [])) addSeen(ix);
  for (const grp of (payload?.meta?.innerInstructions || [])) for (const ix of (grp.instructions||[])) addSeen(ix);

  dbg('[amm] seen programs =>', [...seen]);
  for (const p of seen) if (set.has(p)) return true;

  return false;
}

function ammAccepted(payload) {
  // si strict => doit matcher la whitelist
  if (CFG.AMM_STRICT) return ammAllowedStrict(payload);

  // sinon: fallback type
  if (['CREATE_POOL','ADD_LIQUIDITY','REMOVE_LIQUIDITY','SWAP'].includes(payload?.type)) {
    // si whitelist existe ET matche => ok
    if (CFG.AMM_PROGRAM_IDS.length) {
      const ok = ammAllowedStrict(payload);
      if (ok) return true;
      // sinon on accepte quand même (mode souple)
      dbg('amm filter: fallback by type (non-strict)');
      return true;
    }
    return true;
  }
  // dernier filet: strict check
  return ammAllowedStrict(payload);
}

/* ===================== Paper engine ===================== */
let openPos = null; // { mint, entry, sizeToken, high, remainingPct }

function trailStopPrice(p) { return p.high * (1 - CFG.TRAIL_GAP); }

async function spotPriceOrFallback(mint, fallback) {
  const lamports = Math.floor(CFG.TRADE_SIZE_SOL * LAMPORTS_PER_SOL);
  const bps = Math.floor(CFG.MAX_SLIPPAGE * 10000);
  for (let i=0; i<5; i++) {
    try {
      const px = await jupSpotPrice({ inputMint: CFG.BASE_SOL_MINT, outputMint: mint, amountLamports: lamports, slippageBps: bps });
      return px;
    } catch { await sleep(200); }
  }
  return fallback;
}

async function paperEnter(mint, entryGuess) {
  const px = await spotPriceOrFallback(mint, entryGuess || 0.000001);
  const fill = px * (1 + 0.5 * CFG.MAX_SLIPPAGE);
  const sizeToken = CFG.TRADE_SIZE_SOL / fill;

  openPos = { mint, entry: fill, sizeToken, high: fill, remainingPct: 1.0 };

  console.log(`🟢 [ENTER] ${mint} @ ${fmt(fill)} SOL/token | size=${fmt(sizeToken)} tok`);
  csv({ event:'enter', side:'BUY', price:fill, sol:CFG.TRADE_SIZE_SOL + CFG.PRIORITY_FEE_SOL, token:sizeToken, extra:mint });

  managePositionLoop().catch(()=>{});
  if (CFG.EXIT_TIMEOUT_MS > 0) {
    setTimeout(() => { if (openPos) { console.log(`⏳ Timeout ${CFG.EXIT_TIMEOUT_MS}ms -> close remaining`); paperExit(1); } }, CFG.EXIT_TIMEOUT_MS);
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
  console.log(`🔴 [EXIT] ${openPos.mint} sell=${fmt(sellTok)} @ ${fmt(fill)} ⇒ pnl=${fmt(pnl)} SOL`);
  csv({ event:'exit', side:'SELL', price:fill, sol:proceedsSOL, token:sellTok, extra:`pnl=${pnl}` });

  if (openPos.sizeToken <= 1e-12) openPos = null;
}

async function managePositionLoop() {
  while (openPos) {
    const mark = await spotPriceOrFallback(openPos.mint, openPos.entry);
    if (mark > openPos.high) openPos.high = mark;

    const up = mark / openPos.entry - 1;
    const down = 1 - mark / openPos.entry;

    if (openPos.remainingPct > 0.99 && up >= CFG.TP1_PCT) {
      await paperExit(CFG.TP1_SELL);
      openPos.remainingPct = 1 - CFG.TP1_SELL;
    }
    if (openPos.remainingPct <= 0.30 && mark <= trailStopPrice(openPos)) { await paperExit(1.0); break; }
    if (down >= CFG.HARD_SL) { await paperExit(1.0); break; }

    await sleep(200);
  }
}

/* ===================== Server ===================== */
const app = express();

// Parse JSON (agrandi + log taille)
app.use(bodyParser.json({ limit: '20mb' }));
app.use((err, _req, res, next) => {
  if (err?.type === 'entity.too.large') {
    console.error('Body too large:', err.message);
    return res.status(413).send('Body too large');
  }
  next(err);
});

// petit middleware debug pour mesurer les batchs & tailles
app.post('/helius-webhook', (req, _res, next) => {
  const body = req.body;
  const batchLen = Array.isArray(body) ? body.length : 1;
  const size = Buffer.byteLength(JSON.stringify(body || {}));
  dbg('[hit] batchLen=', batchLen);
  dbg('[hit] /helius-webhook bodySize=' + size + 'B');
  next();
});

// de-dup courte durée
const seenMintTs = new Map(); // mint => ts

app.post('/helius-webhook', async (req, res) => {
  try {
    const items = Array.isArray(req.body) ? req.body : [req.body];

    for (const payload of items) {
      const t = payload?.type || 'UNKNOWN';

      // filtre AMM (souple/strict)
      if (!ammAccepted(payload)) {
        dbg('skip: amm-filter-skip');
        continue;
      }

      // types utiles
      if (!['CREATE_POOL','ADD_LIQUIDITY'].includes(t)) continue;

      const mint = extractMint(payload);
      const added = estimateSolAdded(payload);
      const src = payload?.source || 'unknown';
      const slot = payload?.slot;

      if (!mint) { console.log('No candidate mint found'); continue; }

      console.log(`🚀 Nouveau token détecté: ${mint} | type=${t}  source=${src} | ~${fmt(added)} SOL ajoutés`);
      csv({ event:'detect', side:'', price:'', sol:added, token:mint, extra:`type=${t}|source=${src}|slot=${slot}` });

      // anti double-traitement 30s
      const now = Date.now();
      if (seenMintTs.get(mint) && now - seenMintTs.get(mint) < 30000) continue;
      seenMintTs.set(mint, now);

      if (added >= CFG.TRIGGER_MIN_SOL && CFG.MODE === 'paper') {
        // tentative de price d’entrée
        let entryGuess = 0.000001;
        try {
          entryGuess = await jupSpotPrice({
            inputMint: CFG.BASE_SOL_MINT,
            outputMint: mint,
            amountLamports: Math.floor(CFG.TRADE_SIZE_SOL * LAMPORTS_PER_SOL),
            slippageBps: Math.floor(CFG.MAX_SLIPPAGE * 10000),
          });
        } catch {}

        await paperEnter(mint, entryGuess);
      }
    }

    return res.status(200).send({ ok:true });
  } catch (e) {
    console.error('webhook error', e);
    return res.status(500).send({ ok:false, error: e.message });
  }
});

app.get('/health', (_req, res) => {
  res.send({
    ok: true,
    mode: CFG.MODE,
    triggerMinSol: CFG.TRIGGER_MIN_SOL,
    ammStrict: CFG.AMM_STRICT,
    whitelist: CFG.AMM_PROGRAM_IDS,
    logLevel: CFG.LOG_LEVEL,
  });
});

app.listen(CFG.PORT, () => {
  console.log(`Mint listener running on :${CFG.PORT} (LOG_LEVEL=${CFG.LOG_LEVEL})`);
});
