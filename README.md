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
````

Copiez le fichier du bot (ex. `snipe_bot_ws_raw_gmgn.js`) à la racine du projet.

---

## 🔐 Configuration (.env)

Exemple complet (profil “Capital Shield” recommandé pour < 0.8 SOL) :

```ini
# --- Réseau / accès ---
RPC_URL="https://mainnet.helius-rpc.com/?api-key=YOUR_KEY"
HELIUS_WS_URL="wss://mainnet.helius-rpc.com/?api-key=YOUR_KEY"
WALLET_SECRET_KEY=BASE58_SECRET_KEY   # ⚠️ Ne partagez JAMAIS

# --- Programmes AMM surveillés ---
AMM_PROGRAM_IDS="pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA,675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8,CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C,LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj,FfYek5vEz23cMkWsdJwG2oa6EphsvXSHrGpdALN4g6W1"
WS_REQUIRE_PATTERN=true

# --- Trading / filtres ---
TRADE_SIZE_SOL=0.15
MAX_POOL_AGE_MS=2000
TRIGGER_MIN_SOL=800
PUMP_TRIGGER_MIN_SOL=1200
MAX_SLIPPAGE=0.20
MAX_PRICE_IMPACT_PCT=18
MIN_OTHER_OVER_OUT=0.985

# --- Fees & priorité ---
ANTI_MEV=true
PRIORITY_FEE_BUY=0.0030
PRIORITY_FEE_SELL=0.0075

# --- Sortie / sécurité ---
EXIT_TIMEOUT_MS=16000
RUG_GUARD_WINDOW_MS=7000
RUG_DROP_PCT=12

# --- Anti-withdraw ---
PRE_SUBMIT_STABILITY_MS=450
PRE_SUBMIT_POLLS=4
PRE_SUBMIT_DROP_PCT=4
ACCT_DROP_PCT_TRIGGER=15

# --- Holders ---
HOLDER_CHECK_PREBUY=true
HOLDER_CHECK_POSTBUY_MS=1500
TOP1_HOLDER_MAX_PCT=40
TOP10_HOLDER_MAX_PCT=85

# --- Mode virtuel ---
VIRTUAL_MODE=true
VIRTUAL_VERBOSE=true
VIRTUAL_MTM_MS=800
VIRTUAL_MTM_CHANGE_PCT=2.5
VIRTUAL_NOTE="paper run"

# --- Divers ---
CSV_FILE=live_trades.csv
LOG_LEVEL=info
PORT=10000
GMGN_HOST=https://gmgn.ai
```

> 🔸 Pour tester : `VIRTUAL_MODE=true`
> 🔸 Pour trader : `VIRTUAL_MODE=false`

---

## ▶️ Lancement

```bash
node snipe_bot_ws_raw_gmgn.js
```

Exemples de logs :

```
WS connected: wss://mainnet.helius-rpc.com
🚀 token=ABCDE... | added≈1020 SOL | age=1768ms
[VIRTUAL] 📥 OPEN mint=ABCDE... @0.001232 SOL
[VIRTUAL][MTM] value=+4.8% after 2.2s
[VIRTUAL] 📤 CLOSE reason=timeout pnl=+0.0071 SOL held=16.0s
```

---

## 📡 Endpoints HTTP

| Endpoint             | Description                                           |
| -------------------- | ----------------------------------------------------- |
| `/health`            | Vérifie la configuration & l’état du bot              |
| `/virtual-positions` | Retourne les positions virtuelles (`open`, `history`) |

---

## 🧾 Exemple de CSV

| time              | event | side  | sol    | token   | extra                                      |
| ----------------- | ----- | ----- | ------ | ------- | ------------------------------------------ |
| 2025-10-10T02:15Z | vbuy  | VBUY  | 0.1500 | 9xMint… | entryRatio=1.042                           |
| 2025-10-10T02:15Z | vsell | VSELL | 0.1587 | 9xMint… | pnl=0.0087 heldMs=1713 reason=reserve-drop |
| 2025-10-10T02:18Z | enter | BUY   | 0.1500 | 9xMint… | hash=...                                   |
| 2025-10-10T02:32Z | exit  | SELL  | 0.1580 | 9xMint… | reason=timeout                             |

> 💡 `VBUY/VSELL` = virtuel, `BUY/SELL` = réel.

---

## 🛡️ Protection intégrée

1️⃣ **Filtre de pool** — Ne s’active que sur de gros dépôts récents
2️⃣ **Route GMGN** — Rejette si impact > `MAX_PRICE_IMPACT_PCT`
3️⃣ **Pré-submit check** — Vérifie la stabilité des réserves SPL
4️⃣ **Holders guard** — Analyse top1/top10 avant & après l’achat
5️⃣ **Post-buy probes** — Vente auto si route SELL s’écroule
6️⃣ **Timeout** — Force SELL après `EXIT_TIMEOUT_MS`

> 🧨 *Les rugs “instantanés” (liquidity=0 en un slot) sont invendables. Le bot les évite plutôt que d’essayer de les sauver.*

---

## 🎛️ Presets intégrés

### 🧩 Mode A — “Capital Shield” (défensif)

* `TRADE_SIZE_SOL=0.15`, `TRIGGER_MIN_SOL=800`
* `MAX_SLIPPAGE=0.20`, `MAX_PRICE_IMPACT_PCT=18`
* `TOP1=40%`, `TOP10=85%`
* `PRIORITY_FEE_SELL=0.0075`
* `EXIT_TIMEOUT_MS=16000`, `RUG_DROP_PCT=12`

### ⚙️ Mode B — “Comeback Prudent”

* `TRADE_SIZE_SOL=0.18`, `TRIGGER_MIN_SOL=650`
* `MAX_PRICE_IMPACT_PCT=20`, `PRIORITY_FEE_SELL=0.0065`
* `EXIT_TIMEOUT_MS=18000`, `RUG_DROP_PCT=13`

---

## ❓ FAQ

**Q. Le mode virtuel est-il précis ?**
Oui, il utilise les **vraies routes SELL GMGN**. Les PnL sont donc réalistes.

**Q. Peut-on tourner sans clé privée ?**
Non. Même en virtuel, le bot vérifie la clé pour cohérence — mais ne l’utilise pas pour envoyer de transactions.

**Q. Comment suivre un trade virtuel ?**
Active `VIRTUAL_VERBOSE=true` pour afficher les logs `[VIRTUAL][MTM]` en temps réel.

**Q. Combien de positions à la fois ?**
1 seule (une par mint). Multi-position possible mais non recommandé < 2 SOL.

---

## 🧠 Bonnes pratiques

* Commencer **toujours** en virtuel
* Ne pas augmenter le `slippage` au-delà de 20 %
* **Priority SELL > BUY**
* Stop manuel journalier (−0.18 SOL)
* Garder des logs propres (`CSV_FILE` et `/virtual-positions`)

---

## 🔒 Sécurité

* Ne partagez **jamais** votre clé privée
* Exécutez sur une machine isolée
* Ne gardez pas plus de **2–3 SOL** sur le wallet utilisé
* Ce bot est fourni à titre éducatif — aucune garantie de profit

---

## 🧩 Dépannage

| Problème                   | Cause probable        | Solution                                          |
| -------------------------- | --------------------- | ------------------------------------------------- |
| `❌ HELIUS_WS_URL manquant` | URL WS vide dans .env | Renseignez `HELIUS_WS_URL`                        |
| `Buy failed: slippage`     | Route non rentable    | Normal → protège ton capital                      |
| `429 rate limited`         | Trop de requêtes RPC  | Baisser `RPC_RPS` à 1                             |
| Aucun trade                | Filtres trop stricts  | Baisser `TRIGGER_MIN_SOL` ou `MIN_OTHER_OVER_OUT` |

---

## 🏁 Démarrage rapide

```bash
# 1. Installer les dépendances
npm install

# 2. Créer et remplir le .env
cp .env.example .env

# 3. Lancer en mode virtuel
node snipe_bot_ws_raw_gmgn.js

# 4. Observer les logs et /virtual-positions
# 5. Passer en réel quand tout est validé
```

---

<div align="center">

**Bonne chasse — et restez 🧠 intelligent, pas 🩸 victime.**
*“Fast is good. Safe is better.”*

💬 Discord / Telegram integration coming soon.

</div>

---
