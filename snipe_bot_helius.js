/**
 * snipe_bot_ws_raw_gmgn.js — v3.1 (Helius WS stricte)
 * - WS Helius logsSubscribe uniquement sur AMM_PROGRAM_IDS
 * - Zero fallback → si liste vide, rien n’est écouté
 * - Garde-fous route GMGN / Rug-guard / timeout sortie
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

/* ====================== HTTP Bucket ====================== */
class HttpBucket {
  constructor({ rps, concurrency, backoffMs }) {
    this.interval = Math.max(1000 / Math.max(1, rps), 50);
    this.maxConc = Math.max(1, concurrency);
    this.backoff = Math.max(100, backoffMs);
    this.queue = [];
    this.running = 0;
    setInterval(() => this._drain(), this.interval);
  }
  push(fn) {
    return new Promise((resolve) => {
      this.queue.push({ fn, resolve });
      this._drain();
    });
  }
  async _drain() {
    while (this.running < this.maxConc && this.queue.length) {
      const task = this.queue.shift();
      this.running++;
      (async () => {
        try {
          const out = await task.fn();
          task.resolve(out);
        } catch (e) {
          if (String(e?.message||'').includes('429')) {
            warn(`429 rate-limited, retry in ${this.backoff}ms`);
            await sleep(this.backoff);
          }
          task.resolve(null);
        } finally {
          this.running--;
        }
      })();
    }
  }
}
const httpBucket = new HttpBucket({
  rps: CFG.RPC_RPS,
  concurrency: CFG.RPC_MAX_CONCURRENCY,
  backoffMs: CFG.RPC_BACKOFF_MS,
});
async function getTransactionOnce(sig, commitment='confirmed') {
  return await httpBucket.push(() => 
    connection.getTransaction(sig, { commitment, maxSupportedTransactionVersion: 0 })
  );
}

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
function ratioOutOverIn(quote) {
  const out = Number(quote?.outAmount||0), inp = Number(quote?.inAmount||0);
  return inp>0 ? out/inp : 0;
}

/* ====================== GMGN helpers ====================== */
async function gmgnGetRoute({ tokenIn, tokenOut, inLamports, fromAddress, slippagePct, feeSol, isAntiMev }) {
  const params = new URLSearchParams({
    token_in_address: tokenIn,
    token_out_address: tokenOut,
    in_amount: String(inLamports),
    from_address: fromAddress,
    slippage: String(slippagePct * 100),
    swap_mode: 'ExactIn',
  });
  if (feeSol && feeSol > 0) params.set('fee', String(feeSol));
  if (isAntiMev) params.set('is_anti_mev', 'true');
  const url = `${CFG.GMGN_HOST}/defi/router/v1/sol/tx/get_swap_route?${params.toString()}`;
  const res = await fetch(url); const data = await res.json().catch(()=>({}));
  if (!res.ok || data.code!==0) throw new Error(`GMGN route error ${JSON.stringify(data)}`);
  return data.data;
}
async function gmgnSubmitSignedTx(base64Signed, isAntiMev=false) {
  const res = await fetch(`${CFG.GMGN_HOST}/txproxy/v1/send_transaction`, {
    method:'POST',headers:{'content-type':'application/json'},
    body: JSON.stringify({ chain:'sol', signedTx: base64Signed, isAntiMev })
  });
  const data = await res.json().catch(()=>({}));
  if (!res.ok || data.code!==0) throw new Error(`GMGN submit error ${JSON.stringify(data)}`);
  return data.data;
}
async function gmgnCheckStatus({ hash, lastValidBlockHeight }) {
  const url=`${CFG.GMGN_HOST}/defi/router/v1/sol/tx/get_transaction_status?hash=${hash}&last_valid_height=${lastValidBlockHeight}`;
  const res=await fetch(url); const data=await res.json().catch(()=>({}));
  if (!res.ok || data.code!==0) throw new Error(`GMGN status error ${JSON.stringify(data)}`);
  return data.data;
}

/* ====================== BUY / SELL ====================== */
async function buyViaGMGN(mint) {
  const inLamports=Math.floor(CFG.TRADE_SIZE_SOL*LAMPORTS_PER_SOL);
  const route=await gmgnGetRoute({tokenIn:CFG.BASE_SOL_MINT,tokenOut:mint,inLamports,fromAddress:WALLET_PK,slippagePct:CFG.MAX_SLIPPAGE,feeSol:CFG.PRIORITY_FEE_SOL,isAntiMev:CFG.ANTI_MEV});
  const unsigned=Buffer.from(route.raw_tx.swapTransaction,'base64');
  const tx=VersionedTransaction.deserialize(unsigned); tx.sign([wallet]);
  const signed=Buffer.from(tx.serialize()).toString('base64');
  const submit=await gmgnSubmitSignedTx(signed,CFG.ANTI_MEV);
  info(`[BUY] pending hash=${submit.hash}`); csv({event:'enter',side:'BUY',sol:CFG.TRADE_SIZE_SOL,token:mint,extra:`hash=${submit.hash}`});
  return {route,hash:submit.hash};
}
async function getTokenBalanceLamports(owner,mint){
  const resp=await connection.getTokenAccountsByOwner(new PublicKey(owner),{mint:new PublicKey(mint)});
  let total=0n; for(const it of resp.value){const acc=await connection.getParsedAccountInfo(it.pubkey); total+=BigInt(acc.value?.data?.parsed?.info?.tokenAmount?.amount||'0');}
  return Number(total);
}
async function sellAllViaGMGN(mint){
  const amountIn=await getTokenBalanceLamports(WALLET_PK,mint); if(amountIn<=0){warn('[SELL] skip no balance');return;}
  const route=await gmgnGetRoute({tokenIn:mint,tokenOut:CFG.BASE_SOL_MINT,inLamports:amountIn,fromAddress:WALLET_PK,slippagePct:CFG.MAX_SLIPPAGE,feeSol:CFG.PRIORITY_FEE_SOL,isAntiMev:CFG.ANTI_MEV});
  const unsigned=Buffer.from(route.raw_tx.swapTransaction,'base64'); const tx=VersionedTransaction.deserialize(unsigned); tx.sign([wallet]);
  const signed=Buffer.from(tx.serialize()).toString('base64'); const submit=await gmgnSubmitSignedTx(signed,CFG.ANTI_MEV);
  info(`[SELL] pending hash=${submit.hash}`); csv({event:'exit',side:'SELL',token:mint,extra:`hash=${submit.hash}`});
}

/* ====================== Rug-guard ====================== */
async function rugGuardAfterBuy({ mint, entryRatio }) {
  const t0=Date.now(),probeIn=Math.max(1,Math.floor(0.01*LAMPORTS_PER_SOL));
  while(Date.now()-t0<CFG.RUG_GUARD_WINDOW_MS){
    try{
      const probe=await gmgnGetRoute({tokenIn:CFG.BASE_SOL_MINT,tokenOut:mint,inLamports:probeIn,fromAddress:WALLET_PK,slippagePct:CFG.MAX_SLIPPAGE,feeSol:CFG.PRIORITY_FEE_SOL,isAntiMev:CFG.ANTI_MEV});
      const ratio=ratioOutOverIn(probe.quote); if(entryRatio>0){const dropPct=(1-(ratio/entryRatio))*100; if(dropPct>=CFG.RUG_DROP_PCT){warn(`[RUG] drop ${dropPct.toFixed(1)}% SELL`); await sellAllViaGMGN(mint); return;}}
    }catch{} await sleep(250);
  }
}

/* ====================== Handler ====================== */
const seenMint=new Map();
async function handleFromTx(sig,tx){
  const mint=extractMintFromTx(tx); if(!mint){info(`[SKIP] no mint sig=${sig}`);return;}
  const added=estimateSolAddedFromTx(tx); const age=poolAgeFromTxMs(tx); const progs=collectProgramsFromTx(tx);
  if(age!=null&&age>CFG.MAX_POOL_AGE_MS){info(`[SKIP] old ${age}ms`);return;}
  if(added<CFG.TRIGGER_MIN_SOL){info(`[SKIP] low added=${fmt(added)}`);return;}
  info(`🚀 token=${mint} added≈${fmt(added)} age=${age}ms sig=${sig}`);
  const now=Date.now(); if(seenMint.get(mint)&&now-seenMint.get(mint)<30000){info(`[SKIP] cooldown`);return;}
  seenMint.set(mint,now); try{const {route}=await buyViaGMGN(mint); rugGuardAfterBuy({mint,entryRatio:ratioOutOverIn(route.quote)});}catch(e){err('Buy failed',e.message);}
}

/* ====================== Helius WS ====================== */
function sanitizedProgramIds(list){return list.filter(id=>PK_RE.test(id));}
class HeliusWS{
  constructor(url){this.url=url;}
  start(ids){
    this.ws=new WebSocket(this.url);
    this.ws.on('open',()=>{info('WS connected');for(const id of ids)this._sub(id);setInterval(()=>{try{this.ws?.ping?.()}catch{}},45000);});
    this.ws.on('message',(d)=>this._msg(d,ids)); this.ws.on('close',()=>{warn('WS closed reconnect');setTimeout(()=>this.start(ids),2000);});
  }
  _sub(pubkey){this.ws?.send(JSON.stringify({jsonrpc:'2.0',id:1,method:'logsSubscribe',params:[{mentions:[pubkey]},{commitment:'processed'}]})); info(`WS subscribed ${pubkey}`);}
  async _msg(d,ids){let m;try{m=JSON.parse(d)}catch{return;} if(m?.method==='logsNotification'){const sig=m?.params?.result?.value?.signature;if(!sig)return;const tx=await getTransactionOnce(sig,'confirmed');if(!tx)return;const progs=collectProgramsFromTx(tx);if(!CFG.AMM_PROGRAM_IDS.some(p=>progs.includes(p)))return;await handleFromTx(sig,tx);}}
}

/* ====================== Start ====================== */
const app=express(); app.use(bodyParser.json({limit:'20mb'}));
app.listen(CFG.PORT,()=>{
  info(`GMGN sniping listener on :${CFG.PORT}`);
  const ws=new HeliusWS(CFG.HELIUS_WS_URL); const programs=sanitizedProgramIds(CFG.AMM_PROGRAM_IDS);
  if(!programs.length){err('❌ Aucun AMM_PROGRAM_IDS → rien n’est écouté');return;}
  ws.start(programs);
});
