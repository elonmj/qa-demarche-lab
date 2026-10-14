# Corrections du harnais et mesure de détection — 14 octobre 2026

**Les cinq points H01–H05 sont corrigés et vérifiés localement. Le harnais produit maintenant des défauts UI exploitables pendant l’exploration. Cela ne démontre pas une découverte autonome complète des bugs métier.**

| Correction | Comportement vérifié |
|---|---|
| H01 · plafond DOM | Budget explicite 1–2000, défaut 200 conservé. Collège observé avec 500. |
| H02 · noms longs | Nom complet utilisé en interne; texte worker borné; ambiguïtés réelles refusées. |
| H03 · exploration | Assertions exécutées à la fin; each-observation vérifie les états rencontrés, y compris les gestes RPC, et garde les défauts transitoires. |
| H04 · consommation | Tokens entrée + sortie normalisés, sans doublonner le cache; compteurs conservés après reprise, absence affichée indisponible. |
| H05 · rapport | report.findings et REPORT.md contiennent attendu, observé, impact, contexte, reproduction et preuves; répétitions dédupliquées. |

Une ressource nécessaire refusée/indisponible ou un champ de mesure absent produit un prérequis bloqué. Une assertion non exécutée après interruption reste non exécutée. Hypothèses modèle, échecs UI et preuves métier restent distincts. Écritures, budgets, réservation et anti-rejeu sont conservés.

Les délais UI sont maintenant configurables et finis (1–20000 ms), avec les valeurs par défaut conservées et chaque geste borné par la deadline restante. Les fixtures de test déclarent 5000 ms par geste et 10000 ms par navigation; ce n’est pas un retry. Un champ en lecture seule est refusé immédiatement pour fill, sans gaspiller un délai d’action.

## Détecte-t-il réellement des bugs ?

**Sur les 21 cas du banc synthétique: 9 bugs détectés, 3 manqués, 0 faux positif.** Rappel 75 % sur les 12 cas défectueux. Les contrôles UI configurés détectent les débordements, erreurs JavaScript et défauts transitoires. Trois cas restent inconclusifs à cause d’une ressource indisponible; ils ne deviennent pas des bugs produit.

Les **3 bugs manqués sont le total 21 pour des lignes 12 et 8**, répété sur trois seeds, sans règle métier/probe configurée. Ils restent dans le dénominateur: le bilan n’annonce pas 100 % de détection globale. Les labels de défaut sont tenus hors des missions, mais le décideur de ce banc est scripté. Ce n’est pas une mesure de rappel LLM.

**Essai avec gpt-6.1-sol: 6 décisions réelles, sans relance ni fallback.** Le worker atteint les trois vues. Le moteur signale le débordement et l’erreur JavaScript, et ne signale rien sur la vue saine. Le worker propose aussi une hypothèse sur l’erreur JavaScript. Les deux défauts factuels viennent des contrats UI génériques, pas d’une certification par le modèle. 80 374 tokens déclarés; coût USD inconnu. Trois vues ne donnent aucune mesure statistique d’autonomie.

## Nouvelle recette OraEtLabora

Les **8 pages sont maintenant observées aux deux tailles**, sans blocage DOM. Sur 48 contrôles: **43 passent, 5 échouent**. Les cinq échecs sont des occurrences de débordement: Collège sur ordinateur, puis Collège, Comité, Informaticien et Secrétaire sur mobile. Toutes ont une fiche et des captures, sans synthèse manuelle du ledger.

Le débordement de Collège est nouvellement confirmé: preuves **0c831848-20a6-4255-9f5c-3ed858e66de1** (ordinateur) et **1e09ceb2-a47a-4396-a026-e32b3ee829c7** (mobile). Correction attendue dans la maquette: contexte et menus visibles dans le viewport; défilement horizontal limité aux tableaux. Source de la maquette inchangée. Ni calculs, isolation serveur, persistence métier, impression ou parcours clavier complet certifiés.

## Validation et reproduction

**146/146 tests passent**, zéro échec. Syntaxe et démo passent. Le benchmark existant garde ses verdicts d’issue et checks indépendants (8/8 cas corrects; évaluation à seeds: 6 vrais positifs, 0 faux positifs, 0 faux négatifs). Ses timings ne sont pas interprétés. Windows local uniquement.

Des essais antérieurs ont échoué sur ce poste chargé: 145/146 tests lors d’un lancement simultané, puis 143/146 avec les anciennes limites de 1200 ms. Le benchmark simultané a une lecture indépendante indisponible sur un cas positif: un bug manqué, sans faux positif. Ces preuves sont conservées. Les fixtures finales déclarent leur nouveau délai fini dans une nouvelle configuration; aucune resoumission dans les anciens journaux, aucun nouvel appel modèle. Le benchmark écrit désormais ses mesures avant de faire échouer sa porte qualité.

```powershell
npm test
npm run check
npm run demo
npm run evaluate:discovery
node fixtures/recheck-static.mjs "<chemin-vers-maquette>"
# Essai séparé, seulement avec un modèle effectivement disponible; max 6 décisions:
node fixtures/discovery-evaluation.mjs --live gpt-6.1-sol
```

Les rapports d’origine sont conservés. Les sorties CLI brutes, quotas et journaux restent privés dans artifacts. [report.json](report.json) contient les compteurs, limites, hash des sources, preuves et résultats structurés.

**Limite restante:** explorer davantage ne suffit pas pour révéler n’importe quel bug. Il faut des missions métier, des attentes approuvées et des probes indépendantes; le worker peut proposer des cas, mais ses conclusions doivent être confrontées à ces preuves.
