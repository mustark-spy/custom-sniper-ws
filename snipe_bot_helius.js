/**
 * GMGN Sniper — entrée rapide sur CREATE_POOL puis sortie au timeout (100%).
 * - Conditions d'entrée : age(pool) <= MAX_POOL_AGE_MS ET SOL ajoutés >= TRIGGER_MIN_SOL
 * - Achat: SOL -> token (GMGN router + submit)
 * - Sortie: token -> SOL (GMGN router + submit) à t+EXIT_TIMEOUT_MS
 */

import 'dotenv/config';
import express from 'express';
import bodyParser from 'body-parser';
import fetch from 'node-fetch';
import bs58 from 'bs58';
import {
  Connection,
  Keypair,
  VersionedTransaction,
  PublicKey,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';

// -------------------- Config --------------------
const CFG = {
  PORT: Number(process.env.PORT || 10000),
  RPC_URL: process.env.RPC_URL || 'https://api.mainnet-beta.solana.com',

  // Détection & gating
  TRIGGER_MIN_SOL: Number(process.env.TRIGGER_MIN_SOL || 200),  // min SOL ajoutés pour trigger
  MAX_POOL_AGE_MS: Number(process.env.MAX_POOL_AGE_MS || 5000), // ex: 5000 = 5s

  // Entrée
  TRADE_SIZE_SOL: Number(process.env.TRADE_SIZE_SOL || 0.20),   // taille de l'ordre en SOL
  MAX_SLIPPAGE: Number(process.env.MAX_SLIPPAGE || 0.30),       // ex: 0.30 (30%)
  PRIORITY_FEE_SOL: Number(process.env.PRIORITY_FEE_SOL || 0.006),

  // Sortie
  EXIT_TIMEOUT_MS: Number(process.env.EXIT_TIMEOUT_MS || 8000), // ex: 8000ms

  // Base SOL (WSOL)
  BASE_SOL_MINT: process.env.BASE_SOL_MINT || 'So11111111111111111111111111111111111111112',

  // GMGN
  GMGN_HOST: process.env.GMGN_HOST || 'https://gmgn.ai',

  // Wallet
  WALLET_SECRET_KEY: process.env.WALLET_SECRET_KEY || '', // base58 secret key

  LOG_LEVEL: (process.env.LOG_LEVEL || 'info').toLowerCase(),
};

const dbg  = (...a) => { if (CFG.LOG_LEVEL === 'debug') console.log(...a); };
const info = (...a) => console.log(...a);
const warn = (...a) => console.warn(...a);
const err  = (...a) => console.error(...a);

if (!CFG.WALLET_SECRET_KEY) {
  err('❌ WALLET_SECRET_KEY manquant (base58).');
  process.exit(1);
}

// -------------------- Setup --------------------
const connection = new Connection(CFG.RPC_URL, { commitment: 'processed' });
const wallet = Keypair.fromSecretKey(bs58.decode(CFG.WALLET_SECRET_KEY));
const WALLET_PK = wallet.publicKey.toBase58();

// -------------------- Utils --------------------
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const fmt6  = (n) => Number(n).toFixed(6);

function nowMs() { return Date.now(); }

function eventUnixMs(payload) {
  // Helius enhanced a souvent timestamp / blockTime
  const t =
    (payload?.timestamp ? Number(payload.timestamp) * 1000 : null) ??
    (payload?.blockTime ? Number(payload.blockTime) * 1000 : null);
  return t || nowMs();
}

function estimateSolAdded(payload) {
  // essaie via tokenTransfers mints == WSOL
  const solMint = CFG.BASE_SOL_MINT;
  const transfers = payload?.tokenTransfers || [];
  let sol = 0;
  for (const x of transfers) if (x.mint === solMint && Number(x.tokenAmount) > 0) sol += Number(x.tokenAmount);
  if (sol > 0) return sol;

  // fallback: lamports "parsed transfer" dans instructions
  let lamports = 0;
  const top = payload?.transaction?.message?.instructions || [];
  const inner = payload?.meta?.innerInstructions || [];
  const scan = (ins) => {
    if (ins?.parsed?.type === 'transfer' && ins?.parsed?.info?.lamports) {
      lamports += Number(ins.parsed.info.lamports);
    }
  };
  top.forEach(scan);
  inner.forEach(g => (g.instructions || []).forEach(scan));
  return lamports / LAMPORTS_PER_SOL;
}

function extractMint(payload) {
  // essaie via accountData.tokenBalanceChanges deltas +
  const acc = payload?.accountData || [];
  const deltas = new Map();
  for (const a of acc) {
    for (const t of (a.tokenBalanceChanges || [])) {
      const mint = t.mint;
      const raw  = Number(t.rawTokenAmount?.tokenAmount || 0);
      const dec  = Number(t.rawTokenAmount?.decimals ?? 9);
      if (raw > 0) deltas.set(mint, (deltas.get(mint) || 0) + raw / (10 ** dec));
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

// -------------------- GMGN helpers --------------------
async function gmgnGetRoute({ tokenIn, tokenOut, inLamports, fromAddress, slippagePct, feeSol }) {
  const url = new URL(`${CFG.GMGN_HOST}/defi/router/v1/sol/tx/get_swap_route`);
  url.searchParams.set('token_in_address', tokenIn);
  url.searchParams.set('token_out_address', tokenOut);
  url.searchParams.set('in_amount', String(inLamports)); // lamports du token IN
  url.searchParams.set('from_address', fromAddress);
  url.searchParams.set('slippage', String(slippagePct * 100)); // API accepte 10 pour 10% —> on met 0.30 => 30
  url.searchParams.set('fee', String(feeSol));               // en SOL
  // swap_mode = ExactIn par défaut

  const res = await fetch(url.toString(), { method: 'GET' });
  const data = await res.json().catch(()=>null);
  if (!data || data.code !== 0 || !data.data?.raw_tx?.swapTransaction) {
    throw new Error(`GMGN route invalid: ${JSON.stringify(data)} {status:${res.status}}`);
  }
  return data.data; // { quote, raw_tx:{swapTransaction,...} }
}

async function gmgnSendSigned(base64Signed) {
  const res = await fetch(`${CFG.GMGN_HOST}/txproxy/v1/send_transaction`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chain: 'sol', signedTx: base64Signed }),
  });
  const data = await res.json().catch(()=>null);
  if (!data || data.code !== 0 || !data.data?.hash) {
    throw new Error(`GMGN submit failed: ${JSON.stringify(data)} {status:${res.status}}`);
  }
  return data.data; // {hash, resArr:[...]}
}

async function signAndSubmitFromRoute(routeRawTxB64) {
  const buf = Buffer.from(routeRawTxB64, 'base64');
  const vtx = VersionedTransaction.deserialize(buf);
  vtx.sign([wallet]);
  const signedB64 = Buffer.from(vtx.serialize()).toString('base64');
  const sub = await gmgnSendSigned(signedB64);
  return sub.hash;
}

// -------------------- SELL helpers --------------------
async function getTokenBalanceLamports(ownerPk, mintPk) {
  const owner = new PublicKey(ownerPk);
  const mint  = new PublicKey(mintPk);
  const resp = await connection.getParsedTokenAccountsByOwner(owner, { mint });
  let ui = 0, dec = 0;
  for (const { account } of resp.value) {
    const info = account.data?.parsed?.info;
    const amt  = Number(info?.tokenAmount?.amount || 0); // en "smallest units"
    const d    = Number(info?.tokenAmount?.decimals || 0);
    ui += amt;
    dec = d; // supposons mêmes décimales
  }
  return { amountLamports: ui, decimals: dec };
}

// -------------------- Buy / Sell core --------------------
async function buyViaGMGN(mint) {
  const inLamports = Math.floor(CFG.TRADE_SIZE_SOL * LAMPORTS_PER_SOL);
  const slippage   = CFG.MAX_SLIPPAGE;     // 0.30 -> 30
  const feeSol     = CFG.PRIORITY_FEE_SOL; // ex 0.006

  const data = await gmgnGetRoute({
    tokenIn: CFG.BASE_SOL_MINT,
    tokenOut: mint,
    inLamports,
    fromAddress: WALLET_PK,
    slippagePct: slippage,
    feeSol,
  });

  const hash = await signAndSubmitFromRoute(data.raw_tx.swapTransaction);
  info(`🟢 [BUY GMGN] hash=${hash}`);
  return { hash, lastValidBlockHeight: data.raw_tx.lastValidBlockHeight };
}

async function sellAllViaGMGN(mint) {
  const { amountLamports } = await getTokenBalanceLamports(WALLET_PK, mint);
  if (!amountLamports || amountLamports <= 0) {
    warn(`sellAll: aucun solde token à vendre (mint=${mint})`);
    return null;
  }
  const slippage = CFG.MAX_SLIPPAGE;
  const feeSol   = CFG.PRIORITY_FEE_SOL;

  const data = await gmgnGetRoute({
    tokenIn: mint,
    tokenOut: CFG.BASE_SOL_MINT,
    inLamports: amountLamports, // tout le solde token en "smallest units"
    fromAddress: WALLET_PK,
    slippagePct: slippage,
    feeSol,
  });

  const hash = await signAndSubmitFromRoute(data.raw_tx.swapTransaction);
  info(`🔴 [SELL GMGN] hash=${hash}`);
  return { hash, lastValidBlockHeight: data.raw_tx.lastValidBlockHeight };
}

// -------------------- Webhook & core logic --------------------
const app = express();
app.use(bodyParser.json({ limit: '20mb' }));

const seenMintTs = new Map(); // anti-refire 30s

app.post('/helius-webhook', async (req, res) => {
  try {
    const payload = Array.isArray(req.body) ? req.body[0] : req.body;
    const t = payload?.type || 'UNKNOWN';
    if (t !== 'CREATE_POOL') { // strictement CREATE_POOL comme demandé
      return res.status(200).send({ ok:true, note:'ignored-type', type:t });
    }

    const mint = extractMint(payload);
    if (!mint) {
      warn('skip: no-mint');
      return res.status(200).send({ ok:true, note:'no-mint' });
    }

    // âge du pool
    const evMs = eventUnixMs(payload);
    const age  = nowMs() - evMs;

    // SOL ajoutés
    const added = estimateSolAdded(payload);

    info(`🚀 Nouveau token: ${mint} | age=${age}ms | added≈${fmt6(added)} SOL | type=${t}`);

    if (age > CFG.MAX_POOL_AGE_MS) {
      dbg(`skip: too-old (${age}ms > ${CFG.MAX_POOL_AGE_MS})`);
      return res.status(200).send({ ok:true, note:'too-old', age });
    }
    if (added < CFG.TRIGGER_MIN_SOL) {
      dbg(`skip: below-threshold (${fmt6(added)} < ${CFG.TRIGGER_MIN_SOL})`);
      return res.status(200).send({ ok:true, note:'below-threshold', added });
    }

    // anti-refire 30s
    const now = nowMs();
    if (seenMintTs.get(mint) && now - seenMintTs.get(mint) < 30000) {
      return res.status(200).send({ ok:true, note:'cooldown' });
    }
    seenMintTs.set(mint, now);

    // BUY
    let buyHash = null;
    try {
      const buy = await buyViaGMGN(mint);
      buyHash = buy?.hash || null;
      info(`[BUY] …pending`);
    } catch (e) {
      err('Buy failed:', e.message);
      return res.status(200).send({ ok:true, note:'buy-failed', err:e.message });
    }

    // schedule EXIT by timeout
    if (CFG.EXIT_TIMEOUT_MS > 0) {
      setTimeout(async () => {
        try {
          await sellAllViaGMGN(mint);
          info(`[EXIT] Timeout ${CFG.EXIT_TIMEOUT_MS}ms => sortie totale déclenchée`);
        } catch (e) {
          err('Sell (timeout) failed:', e.message);
        }
      }, CFG.EXIT_TIMEOUT_MS);
    }

    return res.status(200).send({ ok:true, triggered:true, mint, age, added, buyHash });
  } catch (e) {
    err('webhook error:', e);
    return res.status(500).send({ ok:false, error:e.message });
  }
});

app.get('/health', (_req, res) => res.send({
  ok: true,
  wallet: WALLET_PK,
  rpc: CFG.RPC_URL,
  triggerMinSol: CFG.TRIGGER_MIN_SOL,
  maxPoolAgeMs: CFG.MAX_POOL_AGE_MS,
  tradeSizeSOL: CFG.TRADE_SIZE_SOL,
  maxSlippage: CFG.MAX_SLIPPAGE,
  priorityFeeSOL: CFG.PRIORITY_FEE_SOL,
  exitTimeoutMs: CFG.EXIT_TIMEOUT_MS,
  gmgnHost: CFG.GMGN_HOST,
}));

app.listen(CFG.PORT, () => {
  info(`GMGN sniping listener on :${CFG.PORT} (LOG_LEVEL=${CFG.LOG_LEVEL})`);
});
