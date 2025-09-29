/**
 * Webhook Helius -> Achat live:
 * 1) Pump trade-local (réessais agressifs, escalation fee, pump-amm puis auto)
 * 2) Fallback Jupiter + Sender /fast avec TIP embarqué
 * + TP/SL/Trailing + timeout
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
  SystemProgram,
  PublicKey,
  TransactionMessage,
} from '@solana/web3.js';

// -------------------- Config --------------------
const CFG = {
  MODE: (process.env.MODE || 'live').toLowerCase(),
  PORT: Number(process.env.PORT || 10000),
  RPC_URL: process.env.RPC_URL || 'https://api.mainnet-beta.solana.com',
  BASE_SOL_MINT: process.env.BASE_SOL_MINT || 'So11111111111111111111111111111111111111112',

  TRIGGER_MIN_SOL: Number(process.env.TRIGGER_MIN_SOL || 200),

  TRADE_SIZE_SOL: Number(process.env.TRADE_SIZE_SOL || 0.15),
  MAX_SLIPPAGE: Number(process.env.MAX_SLIPPAGE || 0.30),

  // Priority fee (SOL) pour BUY/SELL côté Pump (escalade)
  PUMP_MIN_PRIORITY_FEE: Number(process.env.PUMP_MIN_PRIORITY_FEE || 0.00001),
  PUMP_MAX_PRIORITY_FEE: Number(process.env.PUMP_MAX_PRIORITY_FEE || 0.0005),

  // Priority fee de base à inclure côté Jupiter (dans la construction d'instructions)
  PRIORITY_FEE_SOL: Number(process.env.PRIORITY_FEE_SOL || 0.008),

  TP1_PCT: Number(process.env.TP1_PCT || 0.40),
  TP1_SELL: Number(process.env.TP1_SELL || 0.70),
  TRAIL_GAP: Number(process.env.TRAIL_GAP || 0.20),
  HARD_SL: Number(process.env.HARD_SL || 0.35),
  EXIT_TIMEOUT_MS: Number(process.env.EXIT_TIMEOUT_MS || 15000),

  // Jupiter
  JUP_Q_URL: process.env.JUPITER_QUOTE_URL || 'https://quote-api.jup.ag/v6/quote',
  JUP_SWAP_INS_URL: process.env.JUPITER_SWAP_INS_URL || 'https://quote-api.jup.ag/v6/swap-instructions',

  // Pump Portal
  PUMP_TRADE_LOCAL_URL: process.env.PUMP_TRADE_LOCAL_URL || 'https://pumpportal.fun/api/trade-local',
  PUMP_RETRIES: Number(process.env.PUMP_RETRIES || 40),         // jusqu'à ~2–3s
  PUMP_RETRY_MIN_MS: Number(process.env.PUMP_RETRY_MIN_MS || 50),
  PUMP_RETRY_MAX_MS: Number(process.env.PUMP_RETRY_MAX_MS || 120),

  // Helius Sender (FAST)
  HELIUS_SENDER_URL: process.env.HELIUS_SENDER_URL || 'http://ewr-sender.helius-rpc.com/fast',

  // AMM allowlist
  AMM_PROGRAM_IDS: (process.env.AMM_PROGRAM_IDS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean),
  AMM_STRICT: ['1','true','yes'].includes(String(process.env.AMM_STRICT || '').toLowerCase()),

  // TIP (OBLIGATOIRE pour /fast -> même TX)
  INCLUDE_TIP: ['1','true','yes'].includes(String(process.env.INCLUDE_TIP || '').toLowerCase()),
  TIP_LAMPORTS: Number(process.env.TIP_LAMPORTS || 1000000), // >= 0.001 SOL
  TIP_ACCOUNTS: (process.env.TIP_ACCOUNTS || '').split(',').map(s => s.trim()).filter(Boolean),

  WALLET_SECRET_KEY: process.env.WALLET_SECRET_KEY || '', // base58
  CSV_FILE: process.env.CSV_FILE || 'live_trades.csv',
  LOG_LEVEL: (process.env.LOG_LEVEL || 'info').toLowerCase(),
};

const PUMP_AMM_PROGRAM = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';

const dbg  = (...a) => { if (CFG.LOG_LEVEL === 'debug') console.log(...a); };
const info = (...a) => console.log(...a);
const warn = (...a) => console.warn(...a);
const err  = (...a) => console.error(...a);

if (!CFG.WALLET_SECRET_KEY) { err('❌ WALLET_SECRET_KEY manquant'); process.exit(1); }
if (!CFG.HELIUS_SENDER_URL) { err('❌ HELIUS_SENDER_URL manquant'); process.exit(1); }
if (CFG.INCLUDE_TIP) {
  if (!CFG.TIP_ACCOUNTS.length) { err('❌ INCLUDE_TIP=1 mais TIP_ACCOUNTS vide'); process.exit(1); }
  if (CFG.TIP_LAMPORTS < 1_000_000) { err('❌ TIP_LAMPORTS doit être >= 1_000_000 (0.001 SOL)'); process.exit(1); }
}

// -------------------- Setup --------------------
const connection = new Connection(CFG.RPC_URL, { commitment: 'processed' });
const wallet = Keypair.fromSecretKey(bs58.decode(CFG.WALLET_SECRET_KEY));
const WALLET_PK = wallet.publicKey.toBase58();

if (!fs.existsSync(CFG.CSV_FILE)) fs.writeFileSync(CFG.CSV_FILE, 'time,event,side,price,sol,token,extra\n');
const csv = (row) => {
  const line = `${new Date().toISOString()},${row.event},${row.side||''},${row.price||''},${row.sol||''},${row.token||''},${row.extra||''}\n`;
  fs.appendFileSync(CFG.CSV_FILE, line);
};

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const jitter = (min, max) => Math.floor(Math.random()*(max-min+1))+min;
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

async function jupBuildSwapV0WithTip({ quoteResponse, tipLamports, tipAccount }) {
  const insRes = await fetch(CFG.JUP_SWAP_INS_URL, {
    method: 'POST',
    headers: { 'Content-Type':'application/json' },
    body: JSON.stringify({
      quoteResponse,
      userPublicKey: WALLET_PK,
      wrapAndUnwrapSOL: true,
      dynamicComputeUnitLimit: true,
      asLegacyTransaction: false,
    }),
  });
  if (!insRes.ok) {
    const t = await insRes.text();
    throw new Error(`swap-instructions ${insRes.status}: ${t}`);
  }
  const insData = await insRes.json();
  const { setupInstructions = [], swapInstruction, cleanupInstruction, addressLookupTables = [] } = insData || {};
  if (!swapInstruction) throw new Error('swap-instructions: missing swapInstruction');

  const altAccounts = [];
  for (const addr of addressLookupTables) {
    const pub = new PublicKey(addr);
    const { value } = await connection.getAddressLookupTable(pub);
    if (!value) throw new Error(`ALT not found on-chain: ${addr}`);
    altAccounts.push(value);
  }

  const ix = [];
  for (const i of setupInstructions) ix.push(i);
  ix.push(swapInstruction);
  if (cleanupInstruction) ix.push(cleanupInstruction);

  if (CFG.INCLUDE_TIP && tipLamports > 0 && tipAccount) {
    ix.push(SystemProgram.transfer({
      fromPubkey: wallet.publicKey,
      toPubkey: new PublicKey(tipAccount),
      lamports: tipLamports,
    }));
  }

  const { blockhash } = await connection.getLatestBlockhash('processed');
  const msg = new TransactionMessage({
    payerKey: wallet.publicKey,
    recentBlockhash: blockhash,
    instructions: ix,
  }).compileToV0Message(altAccounts);

  const vtx = new VersionedTransaction(msg);
  vtx.sign([wallet]);
  return vtx;
}

// -------------------- Pump trade-local amélioré --------------------
async function pumpTradeLocalTryOnce({ mint, solAmount, slippagePct, priorityFee, pool, denomAsString }) {
  const body = {
    publicKey: WALLET_PK,
    action: 'buy',
    mint,
    denominatedInSol: denomAsString ? 'true' : true,  // teste string OU boolean
    amount: Number(solAmount),                        // en SOL
    slippage: Math.round(slippagePct * 100),          // 0.30 => 30 (%)
    priorityFee: Number(priorityFee),                 // SOL
    pool,                                            // 'pump-amm' ou 'auto'
  };

  const res = await fetch(CFG.PUMP_TRADE_LOCAL_URL, {
    method: 'POST',
    headers: { 'Content-Type':'application/json' },
    body: JSON.stringify(body),
  });

  if (res.ok) {
    const buf = new Uint8Array(await res.arrayBuffer());
    return { vtx: VersionedTransaction.deserialize(buf), err: null, rawErr: null };
  }

  const txt = await res.text().catch(()=> '');
  return { vtx: null, err: `pump trade-local ${res.status}`, rawErr: txt || null };
}

async function pumpTradeLocalBuildTxAggressive({ mint, solAmount, slippagePct }) {
  // escalade priorityFee de min -> max sur la fenêtre de retries
  const minF = CFG.PUMP_MIN_PRIORITY_FEE;
  const maxF = CFG.PUMP_MAX_PRIORITY_FEE;
  const steps = Math.max(1, CFG.PUMP_RETRIES - 1);

  for (let i = 0; i < CFG.PUMP_RETRIES; i++) {
    const alpha = i / steps;
    const fee = minF + (maxF - minF) * alpha;

    // 1) d’abord pump-amm + denominatedInSol boolean
    let r = await pumpTradeLocalTryOnce({ mint, solAmount, slippagePct, priorityFee: fee, pool: 'pump-amm', denomAsString: false });
    if (r.vtx) return r.vtx;

    // 2) s’il échoue, retente rapidement avec denominatedInSol "true" (string)
    r = await pumpTradeLocalTryOnce({ mint, solAmount, slippagePct, priorityFee: fee, pool: 'pump-amm', denomAsString: true });
    if (r.vtx) return r.vtx;

    // 3) dernier essai sur ce cycle en 'auto'
    r = await pumpTradeLocalTryOnce({ mint, solAmount, slippagePct, priorityFee: fee, pool: 'auto', denomAsString: false });
    if (r.vtx) return r.vtx;

    // LOG clair du motif (montre le JSON entier quand possible)
    if (r.err) {
      warn(`[pump] attempt ${i+1}/${CFG.PUMP_RETRIES} — ${r.err} — body=${r.rawErr}`);
    }

    await sleep(jitter(CFG.PUMP_RETRY_MIN_MS, CFG.PUMP_RETRY_MAX_MS));
  }
  throw new Error('pump trade-local: all retries exhausted');
}

// -------------------- Sender /fast --------------------
async function sendViaHeliusFAST(versionedTx) {
  const raw = Buffer.from(versionedTx.serialize()).toString('base64');
  const res = await fetch(CFG.HELIUS_SENDER_URL, {
    method: 'POST',
    headers: { 'Content-Type':'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'helius-snipe',
      method: 'sendTransaction',
      params: [raw, { encoding: 'base64' }],
    }),
  });
  const data = await res.json();
  if (!data?.result) throw new Error(`Helius sender error: ${JSON.stringify(data)}`);
  return data.result;
}

// -------------------- Price/TP/SL --------------------
async function spotPriceFast(mint, { attempts = 14 } = {}) {
  const lamports = Math.floor(CFG.TRADE_SIZE_SOL * LAMPORTS_PER_SOL);
  const bps = Math.floor(CFG.MAX_SLIPPAGE * 10000);
  for (let i = 0; i < attempts; i++) {
    try {
      const q = await jupQuote({ inputMint: CFG.BASE_SOL_MINT, outputMint: mint, amountLamports: lamports, slippageBps: bps });
      const px = priceFromQuote(q);
      if (px) return px;
    } catch {}
    await sleep(120);
  }
  return null;
}

// -------------------- AMM helpers --------------------
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
  if (!CFG.AMM_PROGRAM_IDS.length) { dbg('amm: allowlist empty -> pass'); return true; }
  const seen = collectPrograms(payload);
  dbg('[amm] seen programs =>', JSON.stringify(seen));
  const allow = new Set(CFG.AMM_PROGRAM_IDS);
  const any = seen.some(p => allow.has(p));
  if (CFG.AMM_STRICT) {
    if (!any) dbg('skip: amm-filter-skip (STRICT; no match)');
    return any;
  } else {
    if (!any) dbg('amm filter: fallback by type (non-strict)');
    return true;
  }
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

// -------------------- Trading core --------------------
let position = null; // { mint, entry, sizeToken, high, remainingPct }
const trailStopPrice = (p) => p.high * (1 - CFG.TRAIL_GAP);
const pickTipAccount = () => CFG.TIP_ACCOUNTS.length ? CFG.TIP_ACCOUNTS[Math.floor(Math.random()*CFG.TIP_ACCOUNTS.length)] : null;

async function buildAndSendBuyTx_FAST({ mint, preferPump }) {
  // 1) Pump trade-local agressif (RPC normal)
  if (preferPump) {
    try {
      const pumpTx = await pumpTradeLocalBuildTxAggressive({
        mint,
        solAmount: CFG.TRADE_SIZE_SOL,
        slippagePct: CFG.MAX_SLIPPAGE,
      });
      const raw = pumpTx.serialize();
      const sig = await connection.sendRawTransaction(raw, {
        skipPreflight: false,
        preflightCommitment: 'processed',
      });
      return { sig, via: 'pump', priceGuess: null };
    } catch (e) {
      warn('pump trade-local exhausted -> fallback Jupiter:', e.message);
    }
  }

  // 2) Jupiter (instructions) + TIP en-tx -> /fast
  const lamports = Math.floor(CFG.TRADE_SIZE_SOL * LAMPORTS_PER_SOL);
  const bps = Math.floor(CFG.MAX_SLIPPAGE * 10000);

  let quote;
  for (let i=0; i<16; i++) {
    try { quote = await jupQuote({ inputMint: CFG.BASE_SOL_MINT, outputMint: mint, amountLamports: lamports, slippageBps: bps }); break; }
    catch { await sleep(120); }
  }
  if (!quote) throw new Error('No route from Jupiter (buy)');

  const vtx = await jupBuildSwapV0WithTip({
    quoteResponse: quote,
    tipLamports: CFG.INCLUDE_TIP ? CFG.TIP_LAMPORTS : 0,
    tipAccount: CFG.INCLUDE_TIP ? pickTipAccount() : null,
  });

  const sig = await sendViaHeliusFAST(vtx);
  const px = priceFromQuote(quote);
  return { sig, via:'jupiter', priceGuess: px };
}

async function liveBuy(mint, preferPump) {
  const { sig, via, priceGuess } = await buildAndSendBuyTx_FAST({ mint, preferPump });
  const px = (priceGuess || 0.000001) * (1 + 0.5 * CFG.MAX_SLIPPAGE);
  const sizeToken = CFG.TRADE_SIZE_SOL / px;

  position = { mint, entry: px, sizeToken, high: px, remainingPct: 1.0 };
  info(`🟢 [ENTER TX SENT/${via}] ${sig} | fill~ ${fmt(px)} SOL/tok | size=${fmt(sizeToken)} tok`);
  csv({ event:'enter', side:'BUY', price:px, sol:CFG.TRADE_SIZE_SOL, token:sizeToken, extra:`sig=${sig}|via=${via}` });
}

async function liveSellPct(pct) {
  if (!position || pct <= 0) return;
  const sellTokenMint = position.mint;
  const sellSize = position.sizeToken * pct;

  const probe = await jupQuote({
    inputMint: CFG.BASE_SOL_MINT,
    outputMint: sellTokenMint,
    amountLamports: Math.floor(0.01 * LAMPORTS_PER_SOL),
    slippageBps: Math.floor(CFG.MAX_SLIPPAGE * 10000),
  }).catch(() => null);
  const tokenDecimals = probe?.data?.[0]?.outAmountDecimals ?? 9;
  const tokenUnits = Math.max(1, Math.floor(sellSize * (10 ** tokenDecimals)));

  const sellQuote = await jupQuote({
    inputMint: sellTokenMint,
    outputMint: CFG.BASE_SOL_MINT,
    amountLamports: tokenUnits,
    slippageBps: Math.floor(CFG.MAX_SLIPPAGE * 10000),
  });

  const vtx = await jupBuildSwapV0WithTip({
    quoteResponse: sellQuote,
    tipLamports: CFG.INCLUDE_TIP ? CFG.TIP_LAMPORTS : 0,
    tipAccount: CFG.INCLUDE_TIP ? pickTipAccount() : null,
  });

  const sig = await sendViaHeliusFAST(vtx);
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
    const px = await spotPriceFast(position.mint, { attempts: 8 }) || position.entry;
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

    await sleep(120);
  }
}

// -------------------- Webhook --------------------
const app = express();
app.use(bodyParser.json({ limit: '20mb' }));
app.use((err, req, res, next) => {
  if (err?.type === 'entity.too.large') { err('Body too large:', err.message); return res.status(413).send('Body too large'); }
  next(err);
});
app.use((req,_res,next)=>{ if(req.path==='/helius-webhook'){ const l=Number(req.headers['content-length']||0); dbg(`[hit] ${req.path} bodySize=${l}B`); if(Array.isArray(req.body)) dbg('[hit] batchLen=', req.body.length); else if(req.body) dbg('[hit] batchLen= 1'); } next(); });

const seenMint = new Map();
const isPumpEvent = (payload) =>
  payload?.source === 'PUMP_AMM' || collectPrograms(payload).includes(PUMP_AMM_PROGRAM);

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
    if (!mint) { warn('skip: no-mint'); return res.status(200).send({ ok:true, note:'no-mint' }); }

    const added = estimateSolAdded(payload);
    const slot = payload?.slot;
    info(`🚀 Nouveau token détecté: ${mint} | type=${t} source=${src} | ~${fmt(added)} SOL ajoutés`);
    csv({ event:'detect', sol:added, token:mint, extra:`type=${t}|source=${src}|slot=${slot}` });

    if (added < CFG.TRIGGER_MIN_SOL) { dbg(`skip: below-threshold (${fmt(added)} < ${CFG.TRIGGER_MIN_SOL})`); return res.status(200).send({ ok:true, note:'below-threshold', added }); }

    const now = Date.now();
    if (seenMint.get(mint) && now - seenMint.get(mint) < 30000) { dbg('skip: cooldown 30s'); return res.status(200).send({ ok:true, note:'cooldown' }); }
    seenMint.set(mint, now);

    const preferPump = isPumpEvent(payload);

    try {
      await liveBuy(mint, preferPump);
      managePositionLoop().catch(()=>{});
      if (CFG.EXIT_TIMEOUT_MS > 0) {
        setTimeout(async () => { if (position && position.mint === mint) { info(`⏳ Timeout ${CFG.EXIT_TIMEOUT_MS}ms => sortie totale`); await liveSellPct(1.0); } }, CFG.EXIT_TIMEOUT_MS);
      }
      return res.status(200).send({ ok:true, triggered:true, mint, added, preferPump });
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
  tip: { include: CFG.INCLUDE_TIP, lamports: CFG.TIP_LAMPORTS, accounts: CFG.TIP_ACCOUNTS.length },
  pump: { retries: CFG.PUMP_RETRIES, retryMinMs: CFG.PUMP_RETRY_MIN_MS, retryMaxMs: CFG.PUMP_RETRY_MAX_MS, minFee: CFG.PUMP_MIN_PRIORITY_FEE, maxFee: CFG.PUMP_MAX_PRIORITY_FEE },
}));

app.listen(CFG.PORT, () => {
  info(`Mint listener running on :${CFG.PORT} (LOG_LEVEL=${CFG.LOG_LEVEL})`);
});
