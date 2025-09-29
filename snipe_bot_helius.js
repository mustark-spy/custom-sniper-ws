/**
 * snipe_bot_helius.js — Lite
 * Détection & log du mint + estimation liquidité SOL (aucun trade, aucun appel Jupiter)
 *
 * ENV utiles:
 *  PORT=3000
 *  LOG_LEVEL=debug|info
 *  AMM_PROGRAM_IDS=orcaEKTd...,RVKd61...,Amm1LV...,675kPX...,pAMMBay6...
 *  HELIUS_PUBLIC_KEY= (optionnel, Ed25519 base58)
 *  HELIUS_SECRET=     (optionnel, HMAC hex)
 *
 * Endpoints:
 *  GET  /health
 *  POST /helius-webhook   (payload Helius Enhanced)
 */

import 'dotenv/config';
import express from 'express';
import bodyParser from 'body-parser';
import crypto from 'crypto';
import nacl from 'tweetnacl';
import bs58 from 'bs58';

/* ----------------- Config ------------------ */
const PORT = Number(process.env.PORT || 3000);
const LOG_LEVEL = (process.env.LOG_LEVEL || 'info').toLowerCase();
const log = (...a) => console.log(...a);
const dbg = (...a) => { if (LOG_LEVEL === 'debug') console.log(...a); };

const CFG = {
  AMM_PROGRAM_IDS: (process.env.AMM_PROGRAM_IDS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean),
  HELIUS_PUBLIC_KEY: process.env.HELIUS_PUBLIC_KEY || '',
  HELIUS_SECRET: process.env.HELIUS_SECRET || '',
  BASE_SOL_MINT: 'So11111111111111111111111111111111111111112',
};

/* ------------- Helpers / filters -------------- */
const SYS_BLACKLIST = new Set([
  '11111111111111111111111111111111', // System
  'SysvarRent111111111111111111111111111111111',
  'ComputeBudget111111111111111111111111111111',
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', // SPL Token
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL', // ATA
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',  // Token-2022
]);

function looksLikeMint(x) {
  return typeof x === 'string' && x.length >= 32 && !SYS_BLACKLIST.has(x);
}
function preferNonSOL(arr) {
  const nonSol = arr.find(m => m !== CFG.BASE_SOL_MINT);
  return nonSol || arr[0] || null;
}

/* --------- Helius signature verification -------- */
function verifyHelius(req, rawBody) {
  const sigHeader = req.headers['x-helius-signature'] || req.headers['x-helio-signature'];
  // Dev mode: si aucune clé n’est fournie, on accepte
  if (!CFG.HELIUS_PUBLIC_KEY && !CFG.HELIUS_SECRET) return true;
  if (!sigHeader) return false;

  if (CFG.HELIUS_PUBLIC_KEY) {
    try {
      const pub = bs58.decode(CFG.HELIUS_PUBLIC_KEY);
      const sig = bs58.decode(String(sigHeader));
      return nacl.sign.detached.verify(Buffer.from(rawBody), sig, pub);
    } catch (e) {
      console.warn('Ed25519 verify error:', e.message);
      return false;
    }
  }
  if (CFG.HELIUS_SECRET) {
    try {
      const hmac = crypto.createHmac('sha256', CFG.HELIUS_SECRET)
        .update(rawBody)
        .digest('hex');
      return hmac === String(sigHeader).toLowerCase();
    } catch (e) {
      console.warn('HMAC verify error:', e.message);
      return false;
    }
  }
  return false;
}

/* --------------- AMM filter ---------------- */
function txTouchesKnownAMMPrograms(payload) {
  // Si pas de filtre configuré -> tout passe
  if (!CFG.AMM_PROGRAM_IDS.length) return true;

  // Acceptation par type enrichi / source pump
  if (['SWAP', 'ADD_LIQUIDITY', 'REMOVE_LIQUIDITY', 'WITHDRAW_LIQUIDITY', 'CREATE_POOL'].includes(payload?.type)) {
    return true;
  }
  if (payload?.source === 'PUMP_AMM') return true;

  // Sinon, tente de trouver un des programIds dans les instructions
  const targets = new Set(CFG.AMM_PROGRAM_IDS);
  const seen = new Set();
  const keys = payload?.transaction?.message?.accountKeys || [];
  const addSeen = (ix) => {
    if (ix?.programId) seen.add(String(ix.programId));
    if (ix?.programIdIndex !== undefined && keys[ix.programIdIndex]) {
      seen.add(String(keys[ix.programIdIndex]));
    }
  };
  (payload?.transaction?.message?.instructions || []).forEach(addSeen);
  (payload?.meta?.innerInstructions || []).forEach(grp => (grp.instructions || []).forEach(addSeen));

  const ok = [...seen].some(p => targets.has(p));
  if (!ok) dbg('AMM filter skip; seen=', [...seen]);
  return ok;
}

/* ----------- Mint extraction (robuste) ------------ */
function extractCandidateMint(payload) {
  const found = [];
  const push = (m) => { if (looksLikeMint(m)) found.push(m); };

  // a) tokenTransfers (top-level Helius)
  (payload.tokenTransfers || []).forEach(t => push(t.mint));

  // b) accountData[].tokenBalanceChanges[].mint (Pump AMM & co)
  (payload.accountData || []).forEach(a =>
    (a.tokenBalanceChanges || []).forEach(c => push(c.mint))
  );

  // c) postTokenBalances (classique)
  (payload?.meta?.postTokenBalances || []).forEach(p => push(p.mint));

  // d) instructions parsed info (mint, tokenMint, mintA/B, baseMint, quoteMint, …)
  const msgIns = payload?.transaction?.message?.instructions || [];
  const inner  = payload?.meta?.innerInstructions || [];
  const scanIx = (ix) => {
    const info = ix?.parsed?.info || {};
    const guesses = [
      info.mint, info.tokenMint, info.mintA, info.mintB,
      info.baseMint, info.quoteMint, info.mintAddress,
      info.tokenAMint, info.tokenBMint, info.mint_a, info.mint_b,
    ];
    guesses.forEach(push);
  };
  msgIns.forEach(scanIx);
  inner.forEach(grp => (grp.instructions || []).forEach(scanIx));

  // e) secours: accountKeys
  if (found.length === 0) {
    (payload?.transaction?.message?.accountKeys || []).forEach(push);
  }

  const uniq = [...new Set(found)].filter(Boolean);
  const chosen = preferNonSOL(uniq);

  if (!chosen && LOG_LEVEL === 'debug') {
    console.log('DEBUG mint not found. Shapes:', {
      hasTokenTransfers: !!payload.tokenTransfers?.length,
      hasAccountData: !!payload.accountData?.length,
      hasPostTokenBalances: !!payload?.meta?.postTokenBalances?.length,
      type: payload?.type, source: payload?.source
    });
  }
  return chosen;
}

/* ----------- Estimation de la liquidité SOL ---------- */
function estimateSOLAdded(payload) {
  let lamports = 0;

  // A) Helius nativeTransfers (souvent présent sur CREATE_POOL / Pump)
  if (Array.isArray(payload.nativeTransfers)) {
    for (const n of payload.nativeTransfers) {
      lamports += Number(n?.amount || 0);
    }
  }

  // B) Fallback: parsed instructions transfer.lamports
  const top = payload?.transaction?.message?.instructions || [];
  const inner = payload?.meta?.innerInstructions || [];
  const scan = (ins) => {
    if (ins?.parsed?.type === 'transfer' && ins?.parsed?.info?.lamports) {
      lamports += Number(ins.parsed.info.lamports);
    }
  };
  top.forEach(scan);
  inner.forEach(grp => (grp.instructions || []).forEach(scan));

  return lamports / 1_000_000_000; // SOL
}

/* ----------------- Server ------------------ */
const app = express();
app.use(bodyParser.json({
  limit: '2mb',
  verify: (req, _res, buf) => { req.rawBody = buf; }
}));

app.get('/health', (_req, res) => {
  res.send({ ok: true, service: 'helius-mint-listener', filterPrograms: CFG.AMM_PROGRAM_IDS.length });
});

app.post('/helius-webhook', async (req, res) => {
  try {
    if (!verifyHelius(req, req.rawBody)) {
      return res.status(401).send({ ok: false, error: 'Invalid Helius signature' });
    }

    const payload = Array.isArray(req.body) ? req.body[0] : req.body;

    // Filtre AMM (si configuré)
    if (!txTouchesKnownAMMPrograms(payload)) {
      return res.status(200).send({ ok: true, note: 'amm-filter-skip' });
    }

    const mint = extractCandidateMint(payload);
    const solAdded = estimateSOLAdded(payload);
    const info = {
      type: payload?.type || null,
      source: payload?.source || null,
      signature: payload?.signature || null,
      slot: payload?.slot || null,
      solAdded,
    };

    if (mint) {
      log(`🚀 Nouveau token détecté: ${mint} | type=${info.type} source=${info.source} | ~${solAdded.toFixed(4)} SOL ajoutés`);
      return res.status(200).send({ ok: true, token: mint, ...info });
    } else {
      log(`⚠️ Aucun mint détecté | type=${info.type} source=${info.source} | ~${solAdded.toFixed(4)} SOL ajoutés`);
      return res.status(200).send({ ok: true, note: 'no-mint', ...info });
    }
  } catch (e) {
    console.error('webhook error:', e);
    return res.status(500).send({ ok: false, error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`Mint listener running on :${PORT} (LOG_LEVEL=${LOG_LEVEL})`);
});
