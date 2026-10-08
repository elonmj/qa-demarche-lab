# Renforcement du harnais — 8 octobre 2026

Périmètre : harnais local, fixtures synthétiques, aucun appel LLM facturé, aucune donnée Colgate.

- [x] H1 — Valider les chemins, contraintes JSON, assertions et plafonds avant ouverture de campagne ; refuser les corps JSON non objets.
- [x] H2 — Masquer les secrets dans les valeurs JSON sans casser les échappements ni laisser passer les secrets imbriqués.
- [x] H3 — Refuser toute réservation/action après fermeture ou défaillance du journal ; terminer les écritures partielles.
- [x] H4 — Appliquer le rôle de mission aux étapes RPC, explorations et probes ; refuser les préparations perdues et les soumissions détournées ; arrêter après panne de quota.
- [x] H5 — Conserver les deux lectures indépendantes pour chaque contrôle, y compris réussi ou indisponible ; ne pas fusionner des défauts de missions différentes.
- [x] H6 — Renvoyer un code de sortie non nul pour les contrôles échoués, bloqués ou inconclusifs ; garantir la fermeture des ressources.

Acceptation : `npm run check`, `npm test`, `npm run demo`, `npm run benchmark`, `node fixtures/visual-qa.mjs`. Régressions ciblées synthétiques avant/après, contrôle des captures mobile/desktop et des erreurs console. Publication GitHub par push et merge autorisée explicitement par le propriétaire après validation.

Résultats : huit régressions reproduites sur le code initial ; suite finale **63/63**, zéro ignoré, 62 019,565 ms sous Windows / Node 24.14.1. Les 21 tests ajoutés couvrent aussi le navigateur réel, un enfant CLI et une panne d'écriture du rapport. Syntaxe et démo (`save-basic: confirmed`) passent. Ce dépôt JavaScript sans bundler ne définit ni `build` ni `lint` ; son contrôle de compilation est `npm run check`.

Benchmark conservé dans `artifacts/benchmark-1791477297086/RESULTS.md` : 8/8 verdicts corrects, zéro rejeu non autorisé et zéro faux positif sur ces cas, zéro appel modèle. Durée QA Lab 15 775 ms contre Playwright écrit 7 675 ms ; mesure locale unique, aucune conclusion de performance générale. Les quatre captures de `artifacts/visual-1791477303973/VIEWS.json` ont été vues, DOM lu, console vide et aucun débordement horizontal à 390/1280 pixels. L'occlusion et le total faux sont des défauts semés intentionnels.

Lecture conceptuelle des rapports, avec les trois personas adaptés au harnais : testeur pressé — oui, tentative/incertitude/confirmation distinguées ; développeur — oui, valeurs et deux preuves par contrôle traçables ; propriétaire — oui, budgets conservés et limites explicites. Ergonomie web et compréhension par de vrais utilisateurs non mesurées.

Compatibilité : les profils JSON fournis restent valides. Une ancienne préparation sans ID de session exige une revue ; les intentions soumises restent rapprochables. Les nouveaux codes 3/4 modifient volontairement le comportement CI des campagnes comportant un contrôle échoué/incomplet. Aucune modification Colgate, aucun appel fournisseur réel ni déploiement de service.

Restent ouverts : validation autonome sur plusieurs fournisseurs et sites réels, intégration Gemini/Antigravity attestée, anonymisation des données inconnues et isolation d'un service web multiutilisateur. Voir [LIMITS.md](LIMITS.md). Ce renforcement ne transforme pas la beta locale en service autonome certifié.
