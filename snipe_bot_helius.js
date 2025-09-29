/**
 * Sniper Pump.fun (GMGN) — buy/sell via GMGN router + TP/SL/Trailing/Timeout
 * + Filtre "fresh pool": n'achète que si CREATE_POOL a < MAX_POOL_AGE_MS (ex: 5s)
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

// ====================== Config ======================
const CFG = {
  MODE: (process.env.MODE || 'live').toLowerCase(),
  PORT: Number(process.env.PORT || 10000),
  RPC_URL: process.env.RPC_URL || 'https://api.mainnet-beta.solana.com',

  // Déclencheur min d’add_liquidity (en SOL) pour snip
  TRIGGER_MIN_SOL: Number(process.env.TRIGGER_MIN_SOL || 50),

  // Trade
  TRADE_SIZE_SOL: Number(process.env.TRADE_SIZE_SOL || 0.15),
  MAX_SLIPPAGE: Number(process.env.MAX_SLIPPAGE || 0.30), // => 30%
  PRIORITY_FEE_SOL: Number(process.env.PRIORITY_FEE_SOL || 0.006), // GMGN "fee" option

  // Strategy
  TP1_PCT: Number(process.env.TP1_PCT || 0.40),     // +40%
  TP1_SELL: Number(process.env.TP1_SELL || 0.70),   // vend 70% sur TP1
  TRAIL_GAP: Number(process.env.TRAIL_GAP || 0.15), // stop suiveur 15% sous le plus haut
  HARD_SL: Number(process.env.HARD_SL || 0.35),     // -35% hard stop
  EXIT_TIMEOUT_MS: Number(process.env.EXIT_TIMEOUT_MS || 15000), // 0 pour désactiver

  // Filtre "je n'entre que dans les X premières secondes du pool"
  MAX_POOL_AGE_MS: Number(process.env.MAX_POOL_AGE_MS || 5000), // <= 5 sec

  // GMGN
  GMGN_HOST: process.env.GMGN_HOST || 'https://gmgn.ai',
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

// ====================== GMGN helpers ======================
function toLamports(sol) { return Math.floor(Number(sol) * LAMPORTS_PER_SOL); }

async function gmgnGetRouteBuy({ mint, amountLamports, slippagePct, feeSol }) {
  const url = new URL(`${CFG.GMGN_HOST}/defi/router/v1/sol/tx/get_swap_route`);
  url.searchParams.set('token_in_address', CFG.BASE_SOL_MINT);
  url.searchParams.set('token_out_address', mint);
  url.searchParams.set('in_amount', String(amountLamports));
  url.searchParams.set('from_address', WALLET_PK);
  url.searchParams.set('slippage', String(slippagePct * 100)); // GMGN lit "10" => 10%
  url.searchParams.set('swap_mode', 'ExactIn');
  if (feeSol && feeSol > 0) url.searchParams.set('fee', String(feeSol));

  const res = await fetch(url.toString(), { method:'GET' });
  const data = await res.json().catch(()=>null);
  if (!res.ok || !data || data.code !== 0) {
    throw new Error(`GMGN route invalid: ${JSON.stringify(data || {status:res.status})}`);
  }
  return data;
}

async function gmgnGetRouteSell({ mint, tokenUnits, slippagePct, feeSol }) {
  const url = new URL(`${CFG.GMGN_HOST}/defi/router/v1/sol/tx/get_swap_route`);
  url.searchParams.set('token_in_address', mint);
  url.searchParams.set('token_out_address', CFG.BASE_SOL_MINT);
  url.searchParams.set('in_amount', String(tokenUnits));
  url.searchParams.set('from_address', WALLET_PK);
  url.searchParams.set('slippage', String(slippagePct * 100));
  url.searchParams.set('swap_mode', 'ExactIn');
  if (feeSol && feeSol > 0) url.searchParams.set('fee', String(feeSol));

  const res = await fetch(url.toString(), { method:'GET' });
  const data = await res.json().catch(()=>null);
  if (!res.ok || !data || data.code !== 0) {
    throw new Error(`GMGN route invalid: ${JSON.stringify(data || {status:res.status})}`);
  }
  return data;
}

async function gmgnSendSignedTx(base64Signed) {
  const res = await fetch(`${CFG.GMGN_HOST}/txproxy/v1/send_transaction`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chain: 'sol', signedTx: base64Signed }),
  });
  const data = await res.json().catch(()=>null);
  if (!res.ok || !data || data.code !== 0) {
    throw new Error(`GMGN send failed: ${JSON.stringify(data || {status:res.status})}`);
  }
  return data;
}

async function gmgnStatus(hash, lastValidHeight) {
  const url = new URL(`${CFG.GMGN_HOST}/defi/router/v1/sol/tx/get_transaction_status`);
  url.searchParams.set('hash', hash);
  url.searchParams.set('last_valid_height', String(lastValidHeight));
  const res = await fetch(url.toString());
  const data = await res.json().catch(()=>null);
  return data;
}

// ====================== Price probe (via GMGN quote) ======================
function priceFromQuote(q) {
  const r = q?.data?.quote;
  if (!r) return null;
  const inAmt = Number(r.inAmount) / (10 ** 9);
  // outAmountDecimals unknown -> GMGN n’expose pas directement; on peut approx via route ou ignorer.
  // Ici on estime SOL/token en utilisant inAmount/outAmount avec mêmes decimals => approximation.
  const outAmt = Number(r.outAmount || r.otherAmountThreshold || 0);
  if (!inAmt || !outAmt) return null;
  return inAmt / outAmt;
}

async function spotPriceFast(mint, { attempts = 6 } = {}) {
  const lamports = Math.floor(CFG.TRADE_SIZE_SOL * LAMPORTS_PER_SOL);
  for (let i=0;i<attempts;i++) {
    try {
      const q = await gmgnGetRouteBuy({
        mint,
        amountLamports: lamports,
        slippagePct: CFG.MAX_SLIPPAGE,
        feeSol: CFG.PRIORITY_FEE_SOL
      });
      const px = priceFromQuote(q);
      if (px) return px;
    } catch {}
    await sleep(120);
  }
  return null;
}

// ====================== Helius helpers ======================
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

// === pool age helpers ===
function eventMillisFromPayload(payload) {
  // Helius enhanced a normalement "timestamp" (seconds).
  if (payload?.timestamp) return Number(payload.timestamp) * 1000;
  if (payload?.blockTime) return Number(payload.blockTime) * 1000;
  return null;
}
async function eventMillisFromSlot(slot) {
  try {
    const sec = await Promise.race([
      connection.getBlockTime(slot),
      new Promise((_r, rej)=>setTimeout(()=>rej(new Error('getBlockTime timeout')), 600))
    ]);
    return sec ? sec*1000 : null;
  } catch { return null; }
}

// ====================== Trading core ======================
let position = null; // { mint, entry, high, remainingPct, startedAt }

const trailStopPrice = (p) => p.high * (1 - CFG.TRAIL_GAP);

async function gmgnBuy(mint) {
  const lamports = Math.floor(CFG.TRADE_SIZE_SOL * LAMPORTS_PER_SOL);
  const route = await gmgnGetRouteBuy({
    mint,
    amountLamports: lamports,
    slippagePct: CFG.MAX_SLIPPAGE,
    feeSol: CFG.PRIORITY_FEE_SOL,
  });

  const swapB64 = route?.data?.raw_tx?.swapTransaction;
  if (!swapB64) throw new Error('GMGN: missing swapTransaction');

  const txBuf = Buffer.from(swapB64, 'base64');
  const vtx = VersionedTransaction.deserialize(txBuf);
  vtx.sign([wallet]);
  const signed = Buffer.from(vtx.serialize()).toString('base64');

  const send = await gmgnSendSignedTx(signed);
  const hash = send?.data?.hash;
  info(`[BUY] …pending  hash=${hash}`);

  // petit poll (non bloquant pour la suite)
  (async ()=>{
    for (let i=0;i<12;i++){
      const st = await gmgnStatus(hash, route?.data?.raw_tx?.lastValidBlockHeight).catch(()=>null);
      if (st?.data?.success) { info(`[BUY] ✅ confirmed`); break; }
      if (st?.data?.expired) { warn(`[BUY] ⛔ expired`); break; }
      await sleep(800);
    }
  })().catch(()=>{});

  return { hash, route };
}

async function gmgnSellPct(mint, pct) {
  // On doit estimer le "tokenUnits" (décimales). GMGN route ne les demande pas explicitement.
  // Approche: demander une route SOL->TOKEN pour lire outAmountDecimals (si dispo), sinon on suppose 9.
  let tokenDecimals = 9;
  try {
    const probe = await gmgnGetRouteBuy({
      mint,
      amountLamports: Math.floor(0.01 * LAMPORTS_PER_SOL),
      slippagePct: CFG.MAX_SLIPPAGE,
      feeSol: CFG.PRIORITY_FEE_SOL,
    });
    // GMGN ne renvoie pas toujours les decimals, on laisse 9 par défaut.
    void probe;
  } catch {}

  // Ici on vend un pourcentage du *reste* via ExactIn: il faudrait le solde token précis.
  // Pour rester simple: on approximera depuis la taille initiale (position.sizeToken)
  const sellTokenUnits = Math.max(1, Math.floor((position.sizeToken * pct) * (10 ** tokenDecimals)));

  const route = await gmgnGetRouteSell({
    mint,
    tokenUnits: sellTokenUnits,
    slippagePct: CFG.MAX_SLIPPAGE,
    feeSol: CFG.PRIORITY_FEE_SOL,
  });

  const swapB64 = route?.data?.raw_tx?.swapTransaction;
  if (!swapB64) throw new Error('GMGN sell: missing swapTransaction');

  const txBuf = Buffer.from(swapB64, 'base64');
  const vtx = VersionedTransaction.deserialize(txBuf);
  vtx.sign([wallet]);
  const signed = Buffer.from(vtx.serialize()).toString('base64');

  const send = await gmgnSendSignedTx(signed);
  const hash = send?.data?.hash;
  info(`[EXIT] …pending  hash=${hash}`);

  (async ()=>{
    for (let i=0;i<12;i++){
      const st = await gmgnStatus(hash, route?.data?.raw_tx?.lastValidBlockHeight).catch(()=>null);
      if (st?.data?.success) { info(`[EXIT] ✅ confirmed`); break; }
      if (st?.data?.expired) { warn(`[EXIT] ⛔ expired`); break; }
      await sleep(800);
    }
  })().catch(()=>{});

  return { hash, route };
}

async function liveSellPct(pct) {
  if (!position || pct <= 0) return;
  const { hash } = await gmgnSellPct(position.mint, pct);
  const soldPct = Math.min(position.remainingPct, pct);
  position.remainingPct -= soldPct;
  info(`🔴 [EXIT ${Math.round(pct*100)}%] ${hash}`);
  csv({ event:'exit', side:'SELL', price:'', sol:'', token:position.mint, extra:`pct=${pct}|hash=${hash}` });
  if (position.remainingPct <= 0.000001) position = null;
}

async function managePositionLoop() {
  while (position) {
    const px = await spotPriceFast(position.mint).catch(()=>null) || position.entry;
    if (px > position.high) position.high = px;

    const up = px / position.entry - 1;
    const down = 1 - px / position.entry;

    if (position.remainingPct > 0.99 && up >= CFG.TP1_PCT) {
      await liveSellPct(CFG.TP1_SELL);
      position && (position.remainingPct = Math.max(0, position.remainingPct));
    }
    if (position && position.remainingPct <= 0.30) {
      const tstop = trailStopPrice(position);
      if (px <= tstop) { await liveSellPct(1.0); break; }
    }
    if (down >= CFG.HARD_SL) { await liveSellPct(1.0); break; }

    await sleep(150);
  }
}

async function liveBuy(mint) {
  // Entrée (GMGN)
  const lamports = Math.floor(CFG.TRADE_SIZE_SOL * LAMPORTS_PER_SOL);
  let entryGuess = 0.000001;
  try {
    const q = await gmgnGetRouteBuy({
      mint,
      amountLamports: lamports,
      slippagePct: CFG.MAX_SLIPPAGE,
      feeSol: CFG.PRIORITY_FEE_SOL
    });
    const px = priceFromQuote(q);
    if (px) entryGuess = px * (1 + 0.5 * CFG.MAX_SLIPPAGE);
  } catch {}

  const { hash } = await gmgnBuy(mint);

  position = {
    mint,
    entry: entryGuess,
    high: entryGuess,
    remainingPct: 1.0,
    startedAt: Date.now(),
    sizeToken: CFG.TRADE_SIZE_SOL / Math.max(1e-12, entryGuess),
  };

  info(`🟢 [BUY GMGN] hash=${hash}  fill~${fmt(entryGuess)} SOL/tok`);
  csv({ event:'enter', side:'BUY', price:entryGuess, sol:CFG.TRADE_SIZE_SOL, token:mint, extra:`hash=${hash}` });

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

// ====================== Webhook ======================
const app = express();
app.use(bodyParser.json({ limit: '20mb' }));

const seenMint = new Map(); // anti-refire 30s

app.post('/helius-webhook', async (req, res) => {
  try {
    const payload = Array.isArray(req.body) ? req.body[0] : req.body;
    const t   = payload?.type || 'UNKNOWN';
    const src = payload?.source || 'unknown';
    const slot = payload?.slot;

    if (!['CREATE_POOL','ADD_LIQUIDITY'].includes(t)) {
      dbg(`skip: ignored-type (${t})`);
      return res.status(200).send({ ok:true, note:'ignored-type', type:t });
    }

    // === Freshness gate (5s par défaut)
    let evtMs = eventMillisFromPayload(payload);
    if (!evtMs && slot) evtMs = await eventMillisFromSlot(slot);
    let ageMs = evtMs ? (Date.now() - evtMs) : null;

    if (ageMs != null) {
      info(`[fresh-check] age=${ageMs}ms  (limit=${CFG.MAX_POOL_AGE_MS}ms)`);
      if (ageMs > CFG.MAX_POOL_AGE_MS) {
        return res.status(200).send({ ok:true, note:'too-old', ageMs });
      }
    } else {
      // si on n’a pas d’heure fiable, on peut choisir de skip pour respecter strictement la règle:
      warn('[fresh-check] no timestamp available -> skip');
      return res.status(200).send({ ok:true, note:'no-timestamp-skip' });
    }

    const mint = extractMint(payload);
    if (!mint) { warn('skip: no-mint'); return res.status(200).send({ ok:true, note:'no-mint' }); }

    const added = estimateSolAdded(payload);
    info(`🚀 Nouveau token: ${mint} | type=${t} src=${src} | ~${fmt(added)} SOL ajoutés`);
    csv({ event:'detect', price:'', sol:added, token:mint, extra:`type=${t}|source=${src}|ageMs=${ageMs}` });

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
      return res.status(200).send({ ok:true, triggered:true, mint, added, ageMs });
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
  maxPoolAgeMs: CFG.MAX_POOL_AGE_MS,
}));

app.listen(CFG.PORT, () => {
  info(`GMGN sniping listener on :${CFG.PORT} (LOG_LEVEL=${CFG.LOG_LEVEL})`);
});
