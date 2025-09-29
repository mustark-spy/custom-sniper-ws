/**
 * Sniper Pump.fun via GMGN Router — buy/sell market + TP/SL/Trailing/Timeout
 * - Entrées/Sorties via GMGN (multi-AMM auto)
 * - Prix spot pour TP/SL via Jupiter Quote (rapide), pas de swap Jupiter.
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
  MAX_SLIPPAGE: Number(process.env.MAX_SLIPPAGE || 0.30), // 30% => 30
  PRIORITY_FEE_SOL: Number(process.env.PRIORITY_FEE_SOL || 0.004), // GMGN fee total
  IS_ANTI_MEV: ['1','true','yes'].includes(String(process.env.IS_ANTI_MEV || '').toLowerCase()),

  // Strategy
  TP1_PCT: Number(process.env.TP1_PCT || 0.40),   // +40%
  TP1_SELL: Number(process.env.TP1_SELL || 0.70), // vend 70% sur TP1
  TRAIL_GAP: Number(process.env.TRAIL_GAP || 0.15), // stop suiveur 15% sous le plus haut
  HARD_SL: Number(process.env.HARD_SL || 0.35),     // -35% hard stop
  EXIT_TIMEOUT_MS: Number(process.env.EXIT_TIMEOUT_MS || 15000), // 0 pour désactiver

  // GMGN
  GMGN_API: process.env.GMGN_API || 'https://gmgn.ai',

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

// ====================== GMGN helpers ======================
function bpsFromSlippage(sl) { return Math.round(sl * 100); } // CFG.MAX_SLIPPAGE=0.30 -> 30

async function gmgnGetRouteExactIn({ tokenIn, tokenOut, amountInLamportsStr }) {
  const url = new URL(`${CFG.GMGN_API}/defi/router/v1/sol/tx/get_swap_route`);
  url.searchParams.set('token_in_address', tokenIn);
  url.searchParams.set('token_out_address', tokenOut);
  url.searchParams.set('in_amount', String(amountInLamportsStr));   // string
  url.searchParams.set('from_address', WALLET_PK);
  url.searchParams.set('slippage', String(bpsFromSlippage(CFG.MAX_SLIPPAGE)));
  url.searchParams.set('swap_mode', 'ExactIn');
  url.searchParams.set('fee', String(CFG.PRIORITY_FEE_SOL));        // number as string
  if (CFG.IS_ANTI_MEV) url.searchParams.set('is_anti_mev', 'true');

  const res = await fetch(url.toString());
  const data = await res.json().catch(()=>null);
  if (!res.ok || !data || data.code !== 0) {
    throw new Error(`GMGN route invalid: ${JSON.stringify(data || {})} {status:${res.status}}`);
  }
  return data.data; // { quote, raw_tx }
}

async function gmgnSendSignedTx(base64, isAnti=false) {
  const res = await fetch(`${CFG.GMGN_API}/txproxy/v1/send_transaction`, {
    method: 'POST',
    headers: {'content-type':'application/json'},
    body: JSON.stringify({ chain:'sol', signedTx: base64, isAntiMev: !!isAnti }),
  });
  const data = await res.json().catch(()=>null);
  if (!res.ok || !data || data.code !== 0) {
    throw new Error(`GMGN send err: ${JSON.stringify(data || {})} {status:${res.status}}`);
  }
  return data.data; // { hash, resArr: [...] }
}

async function gmgnPollStatus(hash, lastValidBlockHeight) {
  // loop until success or expired
  const url = new URL(`${CFG.GMGN_API}/defi/router/v1/sol/tx/get_transaction_status`);
  url.searchParams.set('hash', hash);
  url.searchParams.set('last_valid_height', String(lastValidBlockHeight));

  while (true) {
    const r = await fetch(url.toString());
    const j = await r.json().catch(()=>null);
    const st = j?.data || {};
    dbg('[status] {', JSON.stringify(st), '}');
    if (st.success === true || st.expired === true || st.failed === true) return st;
    await sleep(500);
  }
}

async function gmgnSwapExactIn({ tokenIn, tokenOut, amountInLamportsStr }) {
  // fetch route
  const route = await gmgnGetRouteExactIn({ tokenIn, tokenOut, amountInLamportsStr });
  const swapTxBuf = Buffer.from(route.raw_tx.swapTransaction, 'base64');
  const vtx = VersionedTransaction.deserialize(swapTxBuf);
  vtx.sign([wallet]);
  const signedB64 = Buffer.from(vtx.serialize()).toString('base64');

  info(`[GMGN] …pending  hash=${route.raw_tx.recentBlockhash}  lvh=${route.raw_tx.lastValidBlockHeight}`);
  const sent = await gmgnSendSignedTx(signedB64, CFG.IS_ANTI_MEV);
  const status = await gmgnPollStatus(sent.hash, route.raw_tx.lastValidBlockHeight);

  return { hash: sent.hash, status };
}

// ====================== Token helpers (balance/decimals) ======================
async function getTokenBalanceLamportsStr(mintStr) {
  const mint = new PublicKey(mintStr);
  // compte associé (ATA) parsé => balance.amount (string, déjà en base units)
  const accs = await connection.getParsedTokenAccountsByOwner(wallet.publicKey, { mint });
  if (!accs.value.length) return { amount: '0', decimals: 0 };
  const parsed = accs.value[0].account.data.parsed.info.tokenAmount;
  // parsed = { amount: '123456', decimals: 6, uiAmount: 0.123456 ... }
  return { amount: String(parsed.amount || '0'), decimals: Number(parsed.decimals || 0) };
}
function pctLamports(amountStr, pct) {
  // amountStr is string (lamports); pct in [0..1]
  const A = BigInt(amountStr);
  const N = BigInt(Math.round(pct * 1_000_000)); // 1e-6 precision
  return (A * N) / 1_000_000n;
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

async function gmgnBuySOLtoToken(mint) {
  const amountLamports = Math.floor(CFG.TRADE_SIZE_SOL * LAMPORTS_PER_SOL);
  const { hash, status } = await gmgnSwapExactIn({
    tokenIn: CFG.BASE_SOL_MINT,
    tokenOut: mint,
    amountInLamportsStr: String(amountLamports),
  });
  info(`🟢 [BUY GMGN] hash=${hash}`);
  if (status.success) info(`[BUY] ✅ confirmed`);
  else if (status.expired) warn(`[BUY] ⏳ expired (likely not landed)`);
  else if (status.failed) warn(`[BUY] ❌ failed`);
}

async function gmgnSellTokenToSOL_pct(mint, pct) {
  // lecture balance (lamports déjà), calc % en BigInt
  const { amount } = await getTokenBalanceLamportsStr(mint);
  if (amount === '0') { warn('sell: no balance'); return; }

  let want = pctLamports(amount, pct);
  if (want <= 0n) { warn('sell: amount <= 0'); return; }

  // retry avec réduction si route échoue (little pool hit / 400…)
  let chunk = want;
  let tries = 0;
  const minUnit = 1n;

  while (chunk > 0n && tries < 5) {
    try {
      const { hash, status } = await gmgnSwapExactIn({
        tokenIn: mint,
        tokenOut: CFG.BASE_SOL_MINT,
        amountInLamportsStr: chunk.toString(),
      });
      info(`🔴 [SELL GMGN] hash=${hash}`);
      if (status.success) { info(`[SELL] ✅ confirmed`); return; }
      if (status.expired) { warn(`[SELL] ⏳ expired — resubmit later`); return; }
      if (status.failed) { warn(`[SELL] ❌ failed`); return; }
      return;
    } catch (e) {
      tries++;
      const msg = String(e.message || '');
      warn(`sell route err (${tries}/5): ${msg}`);
      // réduction du chunk si route invalide
      chunk = (chunk * 3n) / 5n; // 60%
      if (chunk < minUnit) { warn('sell: chunk < 1, abort'); break; }
      await sleep(200);
    }
  }
}

// wrappers de stratégie
async function liveSellPct(pct) {
  if (!position || pct <= 0) return;
  await gmgnSellTokenToSOL_pct(position.mint, pct);
  const soldPct = Math.min(position.remainingPct, pct);
  position.remainingPct -= soldPct;
  csv({ event:'exit', side:'SELL', token:position.mint, extra:`pct=${pct}` });
  if (position.remainingPct <= 0.000001) position = null;
}

async function managePositionLoop() {
  while (position) {
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
      if (px <= tstop) { await liveSellPct(1.0); break; }
    }

    // Hard SL
    if (down >= CFG.HARD_SL) { await liveSellPct(1.0); break; }

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

  await gmgnBuySOLtoToken(mint);
  position = {
    mint,
    entry: entryGuess,
    high: entryGuess,
    remainingPct: 1.0,
    startedAt: Date.now(),
  };

  info(`🟢 [ENTER/gmgn] ${mint}  fill~${fmt(entryGuess)} SOL/tok`);
  csv({ event:'enter', side:'BUY', price:entryGuess, sol:CFG.TRADE_SIZE_SOL, token:mint });

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
    info(`🚀 Nouveau token: ${mint} | type=${t} src=${src} | ~${fmt(added)} SOL ajoutés`);
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
  gmgn: { api: CFG.GMGN_API, fee: CFG.PRIORITY_FEE_SOL, antiMev: CFG.IS_ANTI_MEV },
}));

app.listen(CFG.PORT, () => {
  info(`GMGN sniping listener on :${CFG.PORT} (LOG_LEVEL=${CFG.LOG_LEVEL})`);
});
