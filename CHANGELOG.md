# Changelog

## 0.2.1 beta — 2026-10-14

Les explorations évaluent désormais les assertions UI déclarées. L'option `timing: "each-observation"` conserve les défauts transitoires, y compris pendant les gestes JSON-RPC. Les échecs produisent des fiches dédupliquées dans `report.findings` et `REPORT.md`, avec contexte, attendu, observé, reproduction, impact et preuves.

- Résolution des étapes écrites par nom complet ; observation worker toujours bornée à 160 caractères et ambiguïtés réelles refusées.
- `maxDomControls` configurable de 1 à 2000, avec défaut 200 conservé.
- Délais UI configurables et finis, gestes bornés par la deadline restante ; aucun retry d'une tentative interrompue.
- Compteurs de tokens normalisés et conservés après reprise ; usage absent affiché indisponible, cache non compté deux fois.
- Ressource requise indisponible ou métrique absente traitée comme prérequis bloqué, sans défaut produit inventé.
- Mesures du benchmark sauvegardées avant sa porte qualité ; nouveau banc `npm run evaluate:discovery` et recette statique locale autorisée.

Validation Windows locale : 146/146 tests, syntaxe et démo réussies. Benchmark existant : 8/8 issues correctes, zéro rejeu non autorisé ; checks métier à seeds : six vrais positifs, zéro faux positif et zéro faux négatif. Nouveau banc UI à 21 cas : neuf bugs détectés sur douze, trois manqués, zéro faux positif. Six décisions Codex réelles atteignent trois vues ; les deux défauts UI sont signalés, la vue saine ne l'est pas.

Les trois bugs manqués sont des totaux métier sans règle/probe configurée. Aucun rappel autonome général, coût USD, sécurité serveur, résultat Linux ou CI distante n'est revendiqué. Écritures consenties, budgets, réservations, quotas, confidentialité et anti-rejeu sont conservés. Journaux et captures restent privés ; les campagnes antérieures ne sont pas réinitialisées.

Voir [le rapport détaillé](docs/campaigns/corrections-2026-10-14/REPORT.md).
