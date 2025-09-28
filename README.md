# Webhook Service (Helius listener)

Service qui écoute les webhooks Helius, applique les checks de sécurité (mint authority, top holders, AMM filter, simulate Jupiter) et déclenche :

- `paperBuy()` si MODE=paper
- un call à l’`executor-service` si MODE=live

## Déploiement sur Render

1. Crée un Web Service
2. Runtime: Node
3. Build command: `npm ci`
4. Start command: `npm start`
5. Ajoute les variables `.env` via Render Dashboard
6. Webhook URL: `https://<render-url>/helius-webhook`

