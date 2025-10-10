<div align="center">

# ⚡ GMGN Sniping Bot — Helius WS + RugGuard AI

**A fully automated Solana sniper with advanced anti-rug & virtual trading mode**  
🛡️ _Built for safety — designed for speed_ 🛡️  

[![Node.js](https://img.shields.io/badge/Node.js-v18%2B-green?logo=node.js)](https://nodejs.org/)
[![Solana](https://img.shields.io/badge/Solana-Mainnet-purple?logo=solana)](https://solana.com)
[![GMGN](https://img.shields.io/badge/Router-GMGN.ai-blue)](https://gmgn.ai)
[![License](https://img.shields.io/badge/license-MIT-orange.svg)](LICENSE)

<img src="https://cryptologos.cc/logos/solana-sol-logo.png?v=025" alt="solana" width="80" height="80"/>

</div>

---

## 🧠 Description

`GMGN Sniping Bot (Helius WS)` est un **bot Solana autonome** capable de détecter en temps réel les **créations de pools** et **addLiquidity** sur plusieurs **AMM**, de calculer la meilleure route via **GMGN Router**, et de **réagir en quelques millisecondes**.

Il est conçu pour survivre dans un environnement **hautement risqué** (memecoins, pump pools) grâce à une **logique de protection multi-niveaux** (anti-withdraw, rug-guard, holders-check, probes SELL, priority exit...).

💡 En mode **virtuel**, il simule tous les trades sans engager de fonds : parfait pour tester tes réglages sans risque.

---

## ✨ Fonctionnalités

- ⚡ **Détection ultra-précoce** via Helius `logsSubscribe` + `signatureSubscribe`
- 🧮 **Analyse route GMGN** + vérifications : price impact, min-out cohérent, slippage max
- 🛡️ **Garde-fous intelligents** :
  - Pré-submit stability (réserves)
  - Post-buy monitoring (accountSubscribe)
  - Holders check (top1 / top10)
  - Probes SELL (200ms)
  - Rug guard (drop prix rapide)
- 💾 **Journal CSV** de toutes les positions (réelles & virtuelles)
- 🌐 **API HTTP** intégrée :
  - `/health` → état du bot
  - `/virtual-positions` → suivi des positions en mode paper
- 🧠 **Mode virtuel (paper)** :
  - Simule tous les ordres BUY/SELL
  - PnL calculé en direct via vraies quotes GMGN
  - Logs `[VIRTUAL][MTM]` avec Mark-to-Market

---

## ⚙️ Prérequis

- Node.js **v18+**
- Une clé API **Helius** (HTTP + WS)
- Accès à **GMGN.ai**
- Un wallet **Solana** avec quelques SOL (mode réel uniquement)

> ⚠️ Les memecoins et nouveaux pools sont très risqués. Utilisez **VIRTUAL_MODE=true** pour tester votre stratégie sans perte.

---

## 📦 Installation

```bash
git clone <your-repo-url>
cd <your-repo>
npm install
```

Copiez le fichier du bot (ex. `snipe_bot_ws_raw_gmgn.js`) à la racine du projet.

---

## 🏁 Démarrage rapide

```bash
npm install
cp .env.example .env
node snipe_bot_ws_raw_gmgn.js
```

---

<div align="center">

**Bonne chasse — et restez 🧠 intelligent, pas 🩸 victime.**  
_“Fast is good. Safe is better.”_  

💬 Discord / Telegram integration coming soon.

</div>
