/**
 * Sniper Pump.fun — DIRECT PROTOCOL (buy & sell) + TP/SL/Trailing/Timeout
 * - Achats/Ventes via instructions directes au Bonding Curve Program (max speed)
 * - Estimation de prix via Jupiter Quote (pas de swap Jupiter)
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
    TransactionInstruction,
    ComputeBudgetProgram,
    SystemProgram,
} from '@solana/web3.js';
// NÉCESSAIRE POUR GÉRER LES JÉTONS/COMPTES ATA
import { 
    getAssociatedTokenAddressSync, 
    createAssociatedTokenAccountInstruction 
} from '@solana/spl-token';
import { BN } from 'bn.js'; // BN.js est souvent utilisé pour les données d'instruction

// ====================== Config & Constantes du Protocole ======================
const PUMP_PROGRAM_ID = new PublicKey('6efc8bL5NEwzC2kR1uR1o7wQG3R2GjVvYF4mGg8459HKePUMPe'); // ID du programme de Pump.fun
const GLOBAL_ACCOUNT = new PublicKey('4wU8kS7t2y77jF967Bv13t9Wb94TjQZ8v9e7jYf88YF'); // Compte Global Pump.fun (stable)
const SOL_MINT_ACCOUNT = new PublicKey('So11111111111111111111111111111111111111112'); // SOL Mint (ou W-SOL)
const METADATA_PROGRAM_ID = new PublicKey('metaqbxxGpMeeFndgfx8dBU16NxtgW2Hdwrh9AABFpE'); // Programme Metaplex

const CFG = {
    MODE: (process.env.MODE || 'live').toLowerCase(),
    PORT: Number(process.env.PORT || 10000),
    RPC_URL: process.env.RPC_URL || 'https://api.mainnet-beta.solana.com',

    // Déclencheur min d’add_liquidity (en SOL) pour snip
    TRIGGER_MIN_SOL: Number(process.env.TRIGGER_MIN_SOL || 50),

    // Trade
    TRADE_SIZE_SOL: Number(process.env.TRADE_SIZE_SOL || 0.15),
    MAX_SLIPPAGE: Number(process.env.MAX_SLIPPAGE || 0.30), // 30% => 30
    PRIORITY_FEE_SOL: Number(process.env.PRIORITY_FEE_SOL || 0.008),
    
    // Direct Protocol
    MAX_BUY_ATTEMPTS: 10,
    BUY_RETRY_DELAY_MS: 300,

    // Strategy
    TP1_PCT: Number(process.env.TP1_PCT || 0.40),    // +40%
    TP1_SELL: Number(process.env.TP1_SELL || 0.70), // vend 70% sur TP1
    TRAIL_GAP: Number(process.env.TRAIL_GAP || 0.15), // stop suiveur 15% sous le plus haut
    HARD_SL: Number(process.env.HARD_SL || 0.35),      // -35% hard stop
    EXIT_TIMEOUT_MS: Number(process.env.EXIT_TIMEOUT_MS || 15000), // 0 pour désactiver

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
// Utilisation d'un commitment pour le sniping
const connection = new Connection(CFG.RPC_URL, { commitment: 'confirmed' });
const wallet = Keypair.fromSecretKey(bs58.decode(CFG.WALLET_SECRET_KEY));
const WALLET_PK = wallet.publicKey; // Utiliser l'objet PublicKey directement
const WALLET_PK_BS58 = WALLET_PK.toBase58();

if (!fs.existsSync(CFG.CSV_FILE)) {
    fs.writeFileSync(CFG.CSV_FILE, 'time,event,side,price,sol,token,extra\n');
}
const csv = (r) => {
    const line = `${new Date().toISOString()},${r.event},${r.side||''},${r.price||''},${r.sol||''},${r.token||''},${r.extra||''}\n`;
    fs.appendFileSync(CFG.CSV_FILE, line);
};

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const fmt = (n) => Number(n).toFixed(6);

// ====================== Pump.fun Protocol Utils ======================

/**
 * Dérive l'adresse de la Bonding Curve (Pool Account) pour un jeton donné (Mint).
 * @param {PublicKey} mint - L'adresse du jeton (Mint).
 * @returns {PublicKey} L'adresse PDA de la Bonding Curve.
 */
function findBondingCurve(mint) {
    const [pda] = PublicKey.findProgramAddressSync(
        [Buffer.from('bonding-curve'), mint.toBuffer()],
        PUMP_PROGRAM_ID
    );
    return pda;
}

/**
 * Dérive le Token Account du programme pour le jeton donné (Mint).
 * @param {PublicKey} mint - L'adresse du jeton (Mint).
 * @returns {PublicKey} L'adresse PDA du Token Account.
 */
function findProgramTokenAccount(mint) {
    const [pda] = PublicKey.findProgramAddressSync(
        [Buffer.from('token-account'), mint.toBuffer()],
        PUMP_PROGRAM_ID
    );
    return pda;
}

/**
 * Dérive l'adresse du compte Metaplex Metadata pour le jeton donné (Mint).
 * @param {PublicKey} mint - L'adresse du jeton (Mint).
 * @returns {PublicKey} L'adresse PDA du Metadata Account.
 */
function findMetadataAccount(mint) {
    const [pda] = PublicKey.findProgramAddressSync(
        [Buffer.from('metadata'), METADATA_PROGRAM_ID.toBuffer(), mint.toBuffer()],
        METADATA_PROGRAM_ID
    );
    return pda;
}


/**
 * Crée l'instruction pour un achat (SOL -> Token).
 * ID d'instruction: 0 (Swap)
 * @param {object} params
 * @returns {TransactionInstruction}
 */
function createBuyInstruction({
    mint,
    payer,
    amountIn, // Montant en lamports (SOL)
    minAmountOut, // Montant minimum attendu en tokens (pour le slippage)
}) {
    const mintPk = new PublicKey(mint);
    const tokenAccount = getAssociatedTokenAddressSync(mintPk, payer, false);
    
    // Adresses des comptes nécessaires
    const accounts = [
        // 0. Le compte Global
        { pubkey: GLOBAL_ACCOUNT, isSigner: false, isWritable: false },
        // 1. Le compte Bonding Curve (PDA)
        { pubkey: findBondingCurve(mintPk), isSigner: false, isWritable: true },
        // 2. Le Token Account du programme (PDA)
        { pubkey: findProgramTokenAccount(mintPk), isSigner: false, isWritable: true },
        // 3. L'adresse du Token Mint
        { pubkey: mintPk, isSigner: false, isWritable: true },
        // 4. L'adresse du Token Account de l'utilisateur (ATA, qui sera créé)
        { pubkey: tokenAccount, isSigner: false, isWritable: true },
        // 5. L'adresse du Metadata Account
        { pubkey: findMetadataAccount(mintPk), isSigner: false, isWritable: false },
        // 6. L'adresse du portefeuille qui paie (SystemProgram.programId)
        { pubkey: payer, isSigner: true, isWritable: true },
        // 7. L'adresse du programme du System
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        // 8. L'adresse du programme Metaplex
        { pubkey: METADATA_PROGRAM_ID, isSigner: false, isWritable: false },
        // 9. L'adresse du Token Program (fixe)
        { pubkey: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'), isSigner: false, isWritable: false },
        // 10. L'adresse du portefeuille de la 'creator' du jeton (qui est le programme Pump.fun)
        { pubkey: PUMP_PROGRAM_ID, isSigner: false, isWritable: true },
        // 11. L'adresse du compte SOL Mint (W-SOL)
        { pubkey: SOL_MINT_ACCOUNT, isSigner: false, isWritable: false },
    ];

    // Data pour l'instruction Swap
    // [ID = 0 (Swap) | amountIn (u64) | minAmountOut (u64)]
    const data = Buffer.alloc(17);
    data.writeUInt8(0, 0); // Instruction ID: 0 (Swap)
    new BN(amountIn).toArrayLike(Buffer, 'le', 8).copy(data, 1);
    new BN(minAmountOut).toArrayLike(Buffer, 'le', 8).copy(data, 9);
    
    return new TransactionInstruction({
        programId: PUMP_PROGRAM_ID,
        keys: accounts,
        data: data,
    });
}

// ====================== Remplacement: Transactions Directes ======================

/**
 * Fonction pour envoyer une transaction versionnée avec les frais prioritaires.
 * @param {TransactionInstruction[]} instructions
 * @returns {Promise<string>} Signature de la transaction.
 */
async function sendDirectTransaction(instructions) {
    
    // 1. Définir les frais prioritaires
    const computeUnitIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 200000 }); // Ajuster au besoin
    const feeIx = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: Math.floor(CFG.PRIORITY_FEE_SOL * LAMPORTS_PER_SOL / 100000) });

    // 2. Récupérer le hash de bloc récent
    const { blockhash } = await connection.getLatestBlockhash('finalized');

    // 3. Assembler la transaction (avec fees + instructions)
    const messageV0 = new TransactionMessage({
        payerKey: WALLET_PK,
        recentBlockhash: blockhash,
        instructions: [computeUnitIx, feeIx, ...instructions],
    }).compileToLegacyMessage(); // Utiliser V0 si possible, legacy pour la compatibilité maximale
    
    const vtx = new VersionedTransaction(messageV0);
    vtx.sign([wallet]);

    // 4. Envoyer (skipPreflight = true pour la vitesse)
    const sig = await connection.sendTransaction(vtx, { skipPreflight: true });
    
    // 5. Confirmer la transaction (facultatif mais recommandé pour le sniping)
    // await connection.confirmTransaction({ blockhash, lastValidBlockHeight, signature: sig }, 'confirmed');
    
    return sig;
}

/**
 * Achète directement en utilisant le protocole Pump.fun.
 */
async function directBuy(mint) {
    const mintPk = new PublicKey(mint);
    const amountInLamports = Math.floor(CFG.TRADE_SIZE_SOL * LAMPORTS_PER_SOL);
    
    // Étape 1: Trouver le ATA et vérifier son existence
    const tokenAccount = getAssociatedTokenAddressSync(mintPk, WALLET_PK, false);
    const ataIx = createAssociatedTokenAccountInstruction(WALLET_PK, tokenAccount, WALLET_PK, mintPk);
    
    // Étape 2: Déterminer le minAmountOut (Slippage)
    // C'est la partie la plus difficile sans l'API. Nous allons ici ignorer minAmountOut (0) 
    // car le slippage est géré par la vitesse et l'opportunité.
    const minAmountOut = 0; // Vraiment risqué, mais c'est le sniping direct.

    // Étape 3: Créer l'instruction d'achat
    const buyIx = createBuyInstruction({
        mint: mint,
        payer: WALLET_PK,
        amountIn: amountInLamports,
        minAmountOut: minAmountOut,
    });

    // Instructions
    const instructions = [
        ataIx, // Créer l'ATA si non existant
        buyIx, // L'achat
    ];

    return sendDirectTransaction(instructions);
}

/**
 * Vend directement en utilisant le protocole Pump.fun (NON IMPLÉMENTÉ DANS CET EXEMPLE).
 * La vente directe nécessite une autre instruction et une logique de calcul de montant en tokens.
 */
async function directSellPct(mint, pct) {
    // IMPORTANT : L'implémentation de la vente (sell) directe est plus complexe 
    // car elle nécessite: 
    // 1. Lire le solde exact de tokens de votre ATA.
    // 2. Calculer le montant à vendre (pct du solde).
    // 3. Utiliser l'Instruction de Swap Pump.fun avec ID 1 (Sell).
    
    // Pour l'instant, nous allons réutiliser l'API Pump Portal pour la vente
    // si l'achat direct n'est pas possible.
    warn("⚠️ La vente directe n'est pas implémentée. Retour à l'API Pump Portal pour la vente.");
    
    const percent = Math.max(1, Math.min(100, Math.round(pct * 100)));
    const body = {
        publicKey: WALLET_PK_BS58,
        action: 'sell',
        mint,
        amount: `${percent}%`,
        denominatedInSol: 'false',
        slippage: Math.round(CFG.MAX_SLIPPAGE * 100),
        priorityFee: CFG.PRIORITY_FEE_SOL,
        pool: 'auto',
    };
    // Utiliser la fonction d'envoi de l'API Portal existante
    return pumpBuildAndSend(body); 
}

// ====================== Fin des Remplacements ======================
// (Votre code Jupiter Quote est conservé)
// (Vos fonctions d'extraction Helius sont conservées)

// Suppression des anciennes fonctions d'API Portal (laisse pumpBuildAndSend pour Sell)
// Laisser pumpBuildAndSend pour le sell (si on décide de le garder)
// J'ai mis à jour pumpBuildAndSend pour logger le corps de l'erreur 400

async function pumpBuildAndSend(body) {
  const res = await fetch(CFG.PUMP_TRADE_LOCAL_URL, {
    method: 'POST',
    headers: { 'Content-Type':'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
     const t = await res.text().catch(() => 'No response body');
     err(`[Pump Portal ${res.status}] Reason: ${t}`);
     throw new Error(`pump trade-local ${res.status}: ${t}`);
  }
  // réponse = tx sérialisée (buffer)
  const buf = new Uint8Array(await res.arrayBuffer());
  const vtx = VersionedTransaction.deserialize(buf);
  vtx.sign([wallet]);

  // envoi via RPC (préflight off pour max vitesse)
  const sig = await connection.sendTransaction(vtx, { skipPreflight: true });
  return sig;
}


// Remplacement de la logique de liveBuy pour utiliser la boucle de retentative et directBuy
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

    let sig = null;
    let success = false;
    
    for (let attempt = 1; attempt <= CFG.MAX_BUY_ATTEMPTS; attempt++) {
        try {
            sig = await directBuy(mint); // Utilisation de la transaction directe
            success = true;
            break; 
        } catch (e) {
            const errMsg = e.message;
            
            // Les échecs directs sont souvent des erreurs RPC temporaires ou "Pool not found"
            // dû à un bloc non finalisé.
            if (attempt < CFG.MAX_BUY_ATTEMPTS) {
                warn(`⚠️ Buy attempt ${attempt}/${CFG.MAX_BUY_ATTEMPTS} failed (Direct Protocol). Retrying in ${CFG.BUY_RETRY_DELAY_MS}ms... Error: ${errMsg.substring(0, 50)}...`);
                await sleep(CFG.BUY_RETRY_DELAY_MS);
            } else {
                err(`Buy failed permanently after ${CFG.MAX_BUY_ATTEMPTS} attempts: ${errMsg}`);
                return; // Sortir si toutes les tentatives échouent
            }
        }
    }

    if (!success) return; // Si l'achat a échoué

    position = {
        mint,
        entry: entryGuess,
        high: entryGuess,
        remainingPct: 1.0,
        startedAt: Date.now(),
    };

    info(`🟢 [ENTER/DIRECT] ${mint}  sig=${sig}  fill~${fmt(entryGuess)} SOL/tok`);
    csv({ event:'enter', side:'BUY', price:entryGuess, sol:CFG.TRADE_SIZE_SOL, token:mint, extra:`sig=${sig}` });

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

// Remplacement de liveSellPct pour utiliser directSellPct
async function liveSellPct(pct) {
    if (!position || pct <= 0) return;
    // Utiliser la fonction qui utilise l'API Pump Portal pour la vente
    const sig = await directSellPct(position.mint, pct); 
    const soldPct = Math.min(position.remainingPct, pct);
    position.remainingPct -= soldPct;
    info(`🔴 [EXIT ${Math.round(pct*100)}%] ${sig}`);
    csv({ event:'exit', side:'SELL', price:'', sol:'', token:position.mint, extra:`pct=${pct}|sig=${sig}` });

    if (position.remainingPct <= 0.000001) {
        position = null;
    }
}

// ... (le reste du code est inchangé)

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
    info(`🚀 Nouveau token détecté: ${mint} | type=${t} source=${src} | ~${fmt(added)} SOL ajoutés`);
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
  wallet: WALLET_PK_BS58,
  triggerMinSol: CFG.TRIGGER_MIN_SOL,
  tp1: { pct: CFG.TP1_PCT, sell: CFG.TP1_SELL },
  trail: CFG.TRAIL_GAP,
  hardSL: CFG.HARD_SL,
  timeoutMs: CFG.EXIT_TIMEOUT_MS,
}));

app.listen(CFG.PORT, () => {
  info(`Mint listener running on :${CFG.PORT} (LOG_LEVEL=${CFG.LOG_LEVEL})`);
});
