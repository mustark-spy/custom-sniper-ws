/**
 * snipe_bot_ws_raw_gmgn.js — v3.1 (Helius WS stricte)
 * - WS Helius logsSubscribe uniquement sur AMM_PROGRAM_IDS
 * - Zero fallback → si liste vide, rien n’est écouté
 * - Garde-fous route GMGN / mini Rug-guard / timeout sortie
 * - Logs propres (skip reason visibles)
 */

import 'dotenv/config';
import express from 'express';
import bodyParser from 'body-parser';
import fetch from 'node-fetch';
import fs from 'fs';
import bs58 from 'bs58';
import WebSocket from 'ws';
import {
  Connection,
  PublicKey,
  Keypair,
  LAMPORTS_PER_SOL,
  VersionedTransaction,
} from '@solana/web3.js';

/* ====================== Config ====================== */
const CFG = {
  PORT: Number(process.env.PORT || 10000),
  RPC_URL: process.env.RPC_URL || 'https://api.mainnet-beta.solana.com',
  HELIUS_WS_URL: process.env.HELIUS_WS_URL || '',

  MAX_POOL_AGE_MS: Number(process.env.MAX_POOL_AGE_MS || 2500),
  TRIGGER_MIN_SOL: Number(process.env.TRIGGER_MIN_SOL || 200),
  PUMP_TRIGGER_MIN_SOL: Number(process.env.PUMP_TRIGGER_MIN_SOL || 350),

  TRADE_SIZE_SOL: Number(process.env.TRADE_SIZE_SOL || 0.20),
  MAX_SLIPPAGE: Number(process.env.MAX_SLIPPAGE || 0.30),
  PRIORITY_FEE_SOL: Number(process.env.PRIORITY_FEE_SOL || 0.006),
  ANTI_MEV: ['1','true','yes'].includes(String(process.env.ANTI_MEV || '').toLowerCase()),

  EXIT_TIMEOUT_MS: Number(process.env.EXIT_TIMEOUT_MS || 15000),

  MAX_PRICE_IMPACT_PCT: Number(process.env.MAX_PRICE_IMPACT_PCT || 22),
  MIN_OTHER_OVER_OUT: Number(process.env.MIN_OTHER_OVER_OUT || 0.965),
  MIN_OUT_PER_SOL: Number(process.env.MIN_OUT_PER_SOL || 0),

  RUG_GUARD_WINDOW_MS: Number(process.env.RUG_GUARD_WINDOW_MS || 2000),
  RUG_DROP_PCT: Number(process.env.RUG_DROP_PCT || 30),

  GMGN_HOST: process.env.GMGN_HOST || 'https://gmgn.ai',
  WALLET_SECRET_KEY: process.env.WALLET_SECRET_KEY || '',
  BASE_SOL_MINT: 'So11111111111111111111111111111111111111112',

  CSV_FILE: process.env.CSV_FILE || 'live_trades.csv',
  LOG_LEVEL: (process.env.LOG_LEVEL || 'info').toLowerCase(),

  AMM_PROGRAM_IDS: (process.env.AMM_PROGRAM_IDS || '')
    .split(',').map(s => s.trim()).filter(Boolean),

  RPC_RPS: Number(process.env.RPC_RPS || 6),
  RPC_MAX_CONCURRENCY: Number(process.env.RPC_MAX_CONCURRENCY || 2),
  RPC_BACKOFF_MS: Number(process.env.RPC_BACKOFF_MS || 700),
};

/* ====================== Logger ====================== */
const dbg  = (...a) => { if (CFG.LOG_LEVEL === 'debug') console.log(...a); };
const info = (...a) => console.log(...a);
const warn = (...a) => console.warn(...a);
const err  = (...a) => console.error(...a);

if (!CFG.WALLET_SECRET_KEY) { err('❌ WALLET_SECRET_KEY manquant'); process.exit(1); }
if (!CFG.HELIUS_WS_URL) { err('❌ HELIUS_WS_URL manquant'); process.exit(1); }

if (!fs.existsSync(CFG.CSV_FILE)) fs.writeFileSync(CFG.CSV_FILE, 'time,event,side,sol,token,extra\n');
const csv = (r) => {
  const line = `${new Date().toISOString()},${r.event},${r.side||''},${r.sol||''},${r.token||''},${r.extra||''}\n`;
  fs.appendFileSync(CFG.CSV_FILE, line);
};

/* ====================== Setup ====================== */
const connection = new Connection(CFG.RPC_URL, { commitment: 'processed' });
const wallet = Keypair.fromSecretKey(bs58.decode(CFG.WALLET_SECRET_KEY));
const WALLET_PK = wallet.publicKey.toBase58();

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const fmt = (n, d=6) => (typeof n === 'number' ? Number(n).toFixed(d) : n);
const PK_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/* ====================== Extract Helpers ====================== */
function tsFromTxMs(tx) { return tx?.blockTime ? tx.blockTime * 1000 : null; }
function poolAgeFromTxMs(tx) { const t = tsFromTxMs(tx); return t ? Date.now() - t : null; }
function estimateSolAddedFromTx(tx) {
  const pre = tx?.meta?.preBalances || [], post = tx?.meta?.postBalances || [];
  let delta = 0; for (let i=0;i<post.length;i++) { const d = (post[i] - (pre[i]||0)); if (d>0) delta += d/LAMPORTS_PER_SOL; }
  return delta;
}
function extractMintFromTx(tx) {
  const pre = tx?.meta?.preTokenBalances || [], post = tx?.meta?.postTokenBalances || [];
  const by = new Map();
  for (const p of post) {
    const mint = p.mint;
    const postAmt = Number(p.uiTokenAmount?.uiAmount || 0);
    const preEntry = pre.find(x => x.accountIndex === p.accountIndex);
    const preAmt = preEntry ? Number(preEntry.uiTokenAmount?.uiAmount || 0) : 0;
    const delta = postAmt - preAmt;
    if (delta > 0) by.set(mint, (by.get(mint)||0) + delta);
  }
  if (!by.size) return null;
  return [...by.entries()].sort((a,b)=>b[1]-a[1])[0][0];
}
function collectProgramsFromTx(tx) {
  const seen = new Set(), keys = tx?.transaction?.message?.accountKeys || [];
  for (const ins of (tx?.transaction?.message?.instructions || [])) {
    if (ins.programId) seen.add(String(ins.programId));
    if (ins.programIdIndex!==undefined && keys[ins.programIdIndex]) seen.add(String(keys[ins.programIdIndex]));
  }
  for (const grp of (tx?.meta?.innerInstructions || [])) {
    for (const ins of (grp.instructions || [])) {
      if (ins.programId) seen.add(String(ins.programId));
      if (ins.programIdIndex!==undefined && keys[ins.programIdIndex]) seen.add(String(keys[ins.programIdIndex]));
    }
  }
  return [...seen];
}

/* ====================== BUY/SELL & Rug-guard (inchangé) ====================== */
// ... (reprend tes fonctions buyViaGMGN, sellAllViaGMGN, rugGuardAfterBuy)
// (je ne les recolle pas ici pour alléger, mais elles restent inchangées)

/* ====================== Handler ====================== */
const seenMint = new Map();
async function handleFromTx(sig, tx) {
  const mint = extractMintFromTx(tx);
  if (!mint) { info(`[SKIP] no mint extracted sig=${sig}`); return; }
  const added = estimateSolAddedFromTx(tx);
  const age = poolAgeFromTxMs(tx);
  const progs = collectProgramsFromTx(tx);
  const src = progs.includes('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA') ? 'PUMP_AMM' : 'unknown';

  const minSol = (src === 'PUMP_AMM') ? CFG.PUMP_TRIGGER_MIN_SOL : CFG.TRIGGER_MIN_SOL;
  if (age!=null && age>CFG.MAX_POOL_AGE_MS) { info(`[SKIP] old-pool ${age}ms mint=${mint}`); return; }
  if (added<minSol) { info(`[SKIP] below-threshold added=${fmt(added)} < ${minSol} mint=${mint}`); return; }

  info(`🚀 token=${mint} | src=${src} | added≈${fmt(added)} SOL | age=${age}ms sig=${sig}`);
  const now = Date.now(); if (seenMint.get(mint)&&now-seenMint.get(mint)<30000) { info(`[SKIP] cooldown mint=${mint}`); return; }
  seenMint.set(mint, now);
  try {
    const { route } = await buyViaGMGN(mint);
    rugGuardAfterBuy({ mint, entryRatio: ratioOutOverIn(route.quote) }).catch(()=>{});
    if (CFG.EXIT_TIMEOUT_MS>0) setTimeout(()=>sellAllViaGMGN(mint), CFG.EXIT_TIMEOUT_MS);
  } catch(e) { err('Buy failed:', e.message); }
}

/* ====================== Helius WS ====================== */
function sanitizedProgramIds(list) {
  return list.filter(id => PK_RE.test(id));
}
class HeliusWS {
  constructor(url) { this.url=url; this.ws=null; this.subs=[]; this.nextId=1; }
  start(ids) {
    this.ws=new WebSocket(this.url);
    this.ws.on('open',()=>{
      info('WS connected:',this.url);
      for(const id of ids) this.logsSubscribeMentions(id);
      setInterval(()=>{ try{this.ws?.ping?.()}catch{} },45000);
    });
    this.ws.on('message',(d)=>this._onMessage(d));
    this.ws.on('close',()=>{warn('WS closed, reconnect in 2s');setTimeout(()=>this.start(ids),2000);});
  }
  logsSubscribeMentions(pubkey) {
    const payload={jsonrpc:'2.0',id:this.nextId++,method:'logsSubscribe',params:[{mentions:[pubkey]},{commitment:'processed'}]};
    this.subs.push(payload); this.ws?.send(JSON.stringify(payload));
    info(`WS subscribed: ${pubkey}`);
  }
  async _onMessage(data){
    let msg;try{msg=JSON.parse(String(data))}catch{return;}
    if(msg?.method==='logsNotification'){
      const sig=msg?.params?.result?.value?.signature; if(!sig)return;
      const tx=await getTransactionOnce(sig,'confirmed'); if(!tx)return;
      const progs=collectProgramsFromTx(tx);
      if(!CFG.AMM_PROGRAM_IDS.some(p=>progs.includes(p))) return; // filtre strict
      await handleFromTx(sig,tx);
    }
  }
}

/* ====================== Start ====================== */
const app=express(); app.use(bodyParser.json({limit:'20mb'}));
app.listen(CFG.PORT,()=>{
  info(`GMGN sniping listener on :${CFG.PORT}`);
  const ws=new HeliusWS(CFG.HELIUS_WS_URL);
  const programs=sanitizedProgramIds(CFG.AMM_PROGRAM_IDS);
  if(!programs.length){err('❌ Aucun AMM_PROGRAM_IDS → aucun WS abonné'); return;}
  ws.start(programs);
});
