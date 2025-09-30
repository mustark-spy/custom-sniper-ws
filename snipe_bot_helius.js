/**
 * GMGN Sniper — Entrée ultra-rapide + garde-fous + rug-guard + sortie timeout
 * - Webhook Helius: CREATE_POOL / ADD_LIQUIDITY
 * - Route & TX: GMGN Router (sign local, submit via GMGN txproxy)
 * - AUCUN TP/SL : sortie totale au timeout
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
  Keypair,
  LAMPORTS_PER_SOL,
  VersionedTransaction,
} from '@solana/web3.js';

// ====================== Config ======================
const CFG = {
  // Serveur
  PORT: Number(process.env.PORT || 10000),

  // RPC local (pour lire soldes & ALT)
  RPC_URL: process.env.RPC_URL || 'https://api.mainnet-beta.solana.com',

  // Filtres d'entrée
  MAX_POOL_AGE_MS: Number(process.env.MAX_POOL_AGE_MS || 2500),
  TRIGGER_MIN_SOL: Number(process.env.TRIGGER_MIN_SOL || 200),        // seuil par défaut
  PUMP_TRIGGER_MIN_SOL: Number(process.env.PUMP_TRIGGER_MIN_SOL || 350), // seuil plus élevé si source === PUMP_AMM

  // Trade
  TRADE_SIZE_SOL: Number(process.env.TRADE_SIZE_SOL || 0.20),
  MAX_SLIPPAGE: Number(process.env.MAX_SLIPPAGE || 0.30), // 30% => 30
  PRIORITY_FEE_SOL: Number(process.env.PRIORITY_FEE_SOL || 0.006),
  ANTI_MEV: ['1','true','yes'].includes(String(process.env.ANTI_MEV || '').toLowerCase()),

  // Sortie
  EXIT_TIMEOUT_MS: Number(process.env.EXIT_TIMEOUT_MS || 15000),

  // Garde-fous route (GMGN)
  MAX_PRICE_IMPACT_PCT: Number(process.env.MAX_PRICE_IMPACT_PCT || 22),  // ex: 22%
  MIN_OTHER_OVER_OUT: Number(process.env.MIN_OTHER_OVER_OUT || 0.965),    // otherAmountThreshold / outAmount
  MIN_OUT_PER_SOL: Number(process.env.MIN_OUT_PER_SOL || 0),              // 0 pour désactiver

  // Rug-guard post-entrée
  RUG_GUARD_WINDOW_MS: Number(process.env.RUG_GUARD_WINDOW_MS || 2000),
  RUG_DROP_PCT: Number(process.env.RUG_DROP_PCT || 30), // (-30%) si tu compares un ratio d'entrée

  // GMGN
  GMGN_HOST: process.env.GMGN_HOST || 'https://gmgn.ai',

  // Wallet
  WALLET_SECRET_KEY: process.env.WALLET_SECRET_KEY || '', // base58

  // Mint SOL
  BASE_SOL_MINT: 'So11111111111111111111111111111111111111112',

  // Divers
  CSV_FILE: process.env.CSV_FILE || 'live_trades.csv',
  LOG_LEVEL: (process.env.LOG_LEVEL || 'info').toLowerCase(),
};

const dbg  = (...a) => { if (CFG.LOG_LEVEL === 'debug') console.log(...a); };
const info = (...a) => console.log(...a);
const warn = (...a) => console.warn(...a);
const err  = (...a) => console.error(...a);

if (!CFG.WALLET_SECRET_KEY) { err('❌ WALLET_SECRET_KEY manquant'); process.exit(1); }

if (!fs.existsSync(CFG.CSV_FILE)) fs.writeFileSync(CFG.CSV_FILE, 'time,event,side,sol,token,extra\n');
const csv = (r) => {
  const line = `${new Date().toISOString()},${r.event},${r.side||''},${r.sol||''},${r.token||''},${r.extra||''}\n`;
  fs.appendFileSync(CFG.CSV_FILE, line);
};

// ====================== Setup ======================
const connection = new Connection(CFG.RPC_URL, { commitment: 'processed' });
const wallet = Keypair.fromSecretKey(bs58.decode(CFG.WALLET_SECRET_KEY));
const WALLET_PK = wallet.publicKey.toBase58();

// ====================== Utils ======================
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const fmt = (n, d=6) => Number(n).toFixed(d);

function tsFromPayloadMs(payload) {
  // Helius envoie généralement blockTime/timestamp en secondes
  const t = payload?.timestamp ?? payload?.blockTime;
  if (!t) return null;
  return Number(t) * 1000;
}
function poolAgeMs(payload) {
  const t = tsFromPayloadMs(payload);
  if (!t) return null;
  return Date.now() - t;
}

function estimateSolAdded(payload) {
  // Approx simple
  const solMint = CFG.BASE_SOL_MINT;
  const t = payload?.tokenTransfers || [];
  let by = 0;
  for (const x of t) if (x.mint === solMint && x.tokenAmount > 0) by += Number(x.tokenAmount);
  if (by > 0) return by;
  // fallback
  const pre = payload?.meta?.preBalances || [];
  const post = payload?.meta?.postBalances || [];
  if (pre.length && post.length) {
    let delta = 0;
    for (let i=0;i<post.length;i++) {
      const diff = (post[i] - (pre[i]||0));
      // lamports transf ?
      if (diff > 0) delta += diff / LAMPORTS_PER_SOL;
    }
    if (delta > 0) return delta;
  }
  return 0;
}

function extractMint(payload) {
  // Essaie token le plus crédité
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

// ====================== GMGN helpers ======================
async function gmgnGetRoute({
  tokenIn, tokenOut, inLamports, fromAddress, slippagePct, feeSol, isAntiMev=false,
}) {
  const params = new URLSearchParams({
    token_in_address: tokenIn,
    token_out_address: tokenOut,
    in_amount: String(inLamports),
    from_address: fromAddress,
    slippage: String(slippagePct * 100), // GMGN attend un pourcentage, ex: 10 pour 10%
    swap_mode: 'ExactIn',
  });
  if (feeSol && feeSol > 0) params.set('fee', String(feeSol));
  if (isAntiMev) params.set('is_anti_mev', 'true');

  const url = `${CFG.GMGN_HOST}/defi/router/v1/sol/tx/get_swap_route?${params.toString()}`;
  const res = await fetch(url);
  const data = await res.json().catch(()=> ({}));

  if (!res.ok || !data || data.code !== 0 || !data.data?.raw_tx?.swapTransaction) {
    throw new Error(`GMGN route invalid: ${JSON.stringify(data)} {status:${res.status}}`);
  }
  return data.data; // {quote, raw_tx:{swapTransaction,lastValidBlockHeight,recentBlockhash,...}}
}

async function gmgnSubmitSignedTx(base64Tx, isAntiMev=false) {
  const body = { chain: 'sol', signedTx: base64Tx };
  if (isAntiMev) body.isAntiMev = true;

  const res = await fetch(`${CFG.GMGN_HOST}/txproxy/v1/send_transaction`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(()=> ({}));
  if (!res.ok || data.code !== 0) {
    throw new Error(`GMGN submit error: ${JSON.stringify(data)} {status:${res.status}}`);
  }
  return data.data; // { hash, resArr:[{hash,err:null}, ...] }
}

async function gmgnCheckStatus({ hash, lastValidBlockHeight }) {
  const url = `${CFG.GMGN_HOST}/defi/router/v1/sol/tx/get_transaction_status?hash=${hash}&last_valid_height=${lastValidBlockHeight}`;
  const res = await fetch(url);
  const data = await res.json().catch(()=> ({}));
  if (!res.ok || data.code !== 0) {
    throw new Error(`GMGN status error: ${JSON.stringify(data)} {status:${res.status}}`);
  }
  return data.data; // { success, failed, expired }
}

function ratioOutOverIn(quote) {
  const out = Number(quote?.outAmount || 0);
  const inp = Number(quote?.inAmount || 0);
  if (inp <= 0) return 0;
  return out / inp;
}

// ====================== Guards (route + rug) ======================
function assertRouteGuards(routeData) {
  const q = routeData.quote || {};
  const impactPct = Number(q?.priceImpactPct || 0) * 100; // 0.18 -> 18%
  const out = Number(q?.outAmount || 0);
  const other = Number(q?.otherAmountThreshold || 0);

  if (impactPct > CFG.MAX_PRICE_IMPACT_PCT) {
    throw new Error(`route-guard: priceImpact ${impactPct.toFixed(2)}% > ${CFG.MAX_PRICE_IMPACT_PCT}%`);
  }
  if (out > 0) {
    const ratioOther = other / out;
    if (ratioOther < CFG.MIN_OTHER_OVER_OUT) {
      throw new Error(`route-guard: other/out ${(ratioOther).toFixed(3)} < ${CFG.MIN_OTHER_OVER_OUT}`);
    }
  }
  if (CFG.MIN_OUT_PER_SOL > 0) {
    const r = ratioOutOverIn(q);
    if (r < CFG.MIN_OUT_PER_SOL) {
      throw new Error(`route-guard: out/in ${r.toFixed(6)} < ${CFG.MIN_OUT_PER_SOL}`);
    }
  }
}

// ====================== BUY / SELL via GMGN ======================
async function buyViaGMGN(mint) {
  const inLamports = Math.floor(CFG.TRADE_SIZE_SOL * LAMPORTS_PER_SOL);

  // 1) route (SOL -> TOKEN)
  const route = await gmgnGetRoute({
    tokenIn: CFG.BASE_SOL_MINT,
    tokenOut: mint,
    inLamports,
    fromAddress: WALLET_PK,
    slippagePct: CFG.MAX_SLIPPAGE,
    feeSol: CFG.PRIORITY_FEE_SOL,
    isAntiMev: CFG.ANTI_MEV,
  });

  // 2) garde-fous route
  assertRouteGuards(route);

  // 3) signer & submit
  const unsigned = Buffer.from(route.raw_tx.swapTransaction, 'base64');
  const tx = VersionedTransaction.deserialize(unsigned);
  tx.sign([wallet]);
  const signed = Buffer.from(tx.serialize()).toString('base64');

  const submit = await gmgnSubmitSignedTx(signed, CFG.ANTI_MEV);
  info(`[BUY] …pending  hash=${submit.hash}`);
  csv({ event:'enter', side:'BUY', sol:CFG.TRADE_SIZE_SOL, token:mint, extra:`hash=${submit.hash}` });

  // 4) poll rapide (non bloquant ici)
  (async () => {
    try {
      const maxMs = 8000;
      const t0 = Date.now();
      while (Date.now() - t0 < maxMs) {
        const st = await gmgnCheckStatus({
          hash: submit.hash,
          lastValidBlockHeight: route.raw_tx.lastValidBlockHeight,
        });
        dbg('[status]', JSON.stringify(st));
        if (st.success) { info('[BUY] ✅ confirmed'); return; }
        if (st.expired || st.failed) { warn('[BUY] ❌ not confirmed (expired/failed)'); return; }
        await sleep(350);
      }
      warn(`Timeout ${maxMs}ms => pas de confirmation`);
    } catch(e) { warn('status error:', e.message); }
  })();

  return { route, hash: submit.hash };
}

async function getTokenBalanceLamports(owner, mint) {
  const ownerPk = new PublicKey(owner);
  const mintPk  = new PublicKey(mint);
  const resp = await connection.getTokenAccountsByOwner(ownerPk, { mint: mintPk });
  let total = 0n;
  for (const it of resp.value) {
    const acc = await connection.getParsedAccountInfo(it.pubkey);
    const amt = BigInt(acc.value?.data?.parsed?.info?.tokenAmount?.amount || '0');
    total += amt;
  }
  return Number(total);
}

async function sellAllViaGMGN(mint) {
  // quantité à vendre = solde en "lamports du token"
  const amountIn = await getTokenBalanceLamports(WALLET_PK, mint);
  if (amountIn <= 0) { warn('[SELL] skip: no token balance'); return null; }

  const route = await gmgnGetRoute({
    tokenIn: mint,
    tokenOut: CFG.BASE_SOL_MINT,
    inLamports: amountIn,
    fromAddress: WALLET_PK,
    slippagePct: CFG.MAX_SLIPPAGE,
    feeSol: CFG.PRIORITY_FEE_SOL,
    isAntiMev: CFG.ANTI_MEV,
  });

  // On peut appliquer les mêmes garde-fous si tu veux être prudent à la sortie (optionnel)
  // assertRouteGuards(route);

  const unsigned = Buffer.from(route.raw_tx.swapTransaction, 'base64');
  const tx = VersionedTransaction.deserialize(unsigned);
  tx.sign([wallet]);
  const signed = Buffer.from(tx.serialize()).toString('base64');

  const submit = await gmgnSubmitSignedTx(signed, CFG.ANTI_MEV);
  info(`[SELL] …pending  hash=${submit.hash}`);
  csv({ event:'exit', side:'SELL', sol:'', token:mint, extra:`hash=${submit.hash}` });

  (async () => {
    try {
      const maxMs = 8000;
      const t0 = Date.now();
      while (Date.now() - t0 < maxMs) {
        const st = await gmgnCheckStatus({
          hash: submit.hash,
          lastValidBlockHeight: route.raw_tx.lastValidBlockHeight,
        });
        if (st.success) { info('[SELL] ✅ confirmed'); return; }
        if (st.expired || st.failed) { warn('[SELL] ❌ not confirmed (expired/failed)'); return; }
        await sleep(350);
      }
      warn('SELL status timeout');
    } catch(e) { warn('SELL status error:', e.message); }
  })();

  return { route, hash: submit.hash };
}

// ====================== RUG GUARD ======================
async function rugGuardAfterBuy({ mint, entryRatio }) {
  if (CFG.RUG_GUARD_WINDOW_MS <= 0) return;

  const t0 = Date.now();
  const probeIn = Math.max(1, Math.floor(0.01 * LAMPORTS_PER_SOL)); // 0.01 SOL

  while (Date.now() - t0 < CFG.RUG_GUARD_WINDOW_MS) {
    try {
      const probe = await gmgnGetRoute({
        tokenIn: CFG.BASE_SOL_MINT,
        tokenOut: mint,
        inLamports: probeIn,
        fromAddress: WALLET_PK,
        slippagePct: CFG.MAX_SLIPPAGE,
        feeSol: CFG.PRIORITY_FEE_SOL,
        isAntiMev: CFG.ANTI_MEV,
      });
      const imp = Number(probe.quote?.priceImpactPct || 0) * 100;
      const ratio = ratioOutOverIn(probe.quote);
      // Drop relatif vs entrée (si on a une ratio d'entrée)
      if (entryRatio > 0) {
        const dropPct = (1 - (ratio / entryRatio)) * 100;
        if (dropPct >= CFG.RUG_DROP_PCT) {
          warn(`[RUG-GUARD] price drop ~${dropPct.toFixed(1)}% ≥ ${CFG.RUG_DROP_PCT}% => SELL NOW`);
          await sellAllViaGMGN(mint);
          return;
        }
      }
      // Impact énorme (coupe-circuit)
      if (imp > Math.max(45, CFG.MAX_PRICE_IMPACT_PCT + 20)) {
        warn(`[RUG-GUARD] impact ${imp.toFixed(1)}% => SELL NOW`);
        await sellAllViaGMGN(mint);
        return;
      }
    } catch(e) {
      // Si la route échoue, c'est possiblement rug → tente sell quand même avec une petite pause
      warn('[RUG-GUARD] probe error:', e.message);
    }
    await sleep(250);
  }
}

// ====================== Webhook server ======================
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
    const added = estimateSolAdded(payload);
    const age = poolAgeMs(payload);
    const ageTxt = (age==null) ? 'n/a' : `${age}ms`;

    // 👉 logs de source
    info(`🚀 Nouveau token: ${mint} | type=${t} src=${src} | added≈${fmt(added,6)} SOL | age=${ageTxt}`);

    // Seuils dynamiques selon la source
    const minSol = (src === 'PUMP_AMM') ? CFG.PUMP_TRIGGER_MIN_SOL : CFG.TRIGGER_MIN_SOL;

    // Filtres de base
    if (age != null && age > CFG.MAX_POOL_AGE_MS) {
      dbg(`skip: old pool (${age}ms > ${CFG.MAX_POOL_AGE_MS}ms)`);
      return res.status(200).send({ ok:true, note:'old-pool', age });
    }
    if (added < minSol) {
      dbg(`skip: below-threshold (${fmt(added)} < ${minSol})`);
      return res.status(200).send({ ok:true, note:'below-threshold', added, minSol });
    }

    // anti-refire 30s
    const now = Date.now();
    if (seenMint.get(mint) && now - seenMint.get(mint) < 30000) {
      return res.status(200).send({ ok:true, note:'cooldown' });
    }
    seenMint.set(mint, now);

    // BUY
    try {
      const { route } = await buyViaGMGN(mint);
      const entryRatio = ratioOutOverIn(route.quote) || 0;

      // Mini Rug-Guard (asynchrone)
      rugGuardAfterBuy({ mint, entryRatio }).catch(()=>{});

      // Timeout de sortie
      if (CFG.EXIT_TIMEOUT_MS > 0) {
        setTimeout(async () => {
          info(`⏳ Timeout ${CFG.EXIT_TIMEOUT_MS}ms => sortie totale`);
          await sellAllViaGMGN(mint);
        }, CFG.EXIT_TIMEOUT_MS);
      }

      return res.status(200).send({ ok:true, triggered:true, mint, added, src, minSol, age });
    } catch (e) {
      err('Buy failed:', e.message);
      return res.status(200).send({ ok:true, note:'buy-failed', err:e.message, src, added, age });
    }

  } catch (e) {
    err('webhook error:', e);
    return res.status(500).send({ ok:false, error: e.message });
  }
});

app.get('/health', (_req, res) => res.send({
  ok: true,
  wallet: WALLET_PK,
  cfg: {
    maxPoolAgeMs: CFG.MAX_POOL_AGE_MS,
    triggerMinSol: CFG.TRIGGER_MIN_SOL,
    pumpTriggerMinSol: CFG.PUMP_TRIGGER_MIN_SOL,
    tradeSizeSOL: CFG.TRADE_SIZE_SOL,
    maxSlippage: CFG.MAX_SLIPPAGE,
    priorityFeeSOL: CFG.PRIORITY_FEE_SOL,
    antiMEV: CFG.ANTI_MEV,
    exitTimeoutMs: CFG.EXIT_TIMEOUT_MS,
    guards: {
      maxPriceImpactPct: CFG.MAX_PRICE_IMPACT_PCT,
      minOtherOverOut: CFG.MIN_OTHER_OVER_OUT,
      minOutPerSol: CFG.MIN_OUT_PER_SOL,
    },
    rugGuard: {
      windowMs: CFG.RUG_GUARD_WINDOW_MS,
      dropPct: CFG.RUG_DROP_PCT,
    },
  },
}));

app.listen(CFG.PORT, () => {
  info(`GMGN sniping listener on :${CFG.PORT} (LOG_LEVEL=${CFG.LOG_LEVEL})`);
});
