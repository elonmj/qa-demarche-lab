# Recette du harnais sur OraEtLabora — 13 octobre 2026

**Verdict : le harnais pilote réellement la maquette, mais sa couverture et ses rapports restent incomplets. Quatre défauts du harnais confirmés, une limite d’intégration bloquante et un défaut responsive groupé de la cible.**

Test effectué avec le moteur existant, son JSON-RPC et un worker Codex réel, sur une copie locale autorisée de données fictives. Commit du harnais : 0b1622542f587e429cb7f64799070ce557a04a6e. Moteur et sources HTML/JS/CSS de la maquette inchangés. Aucun enregistrement serveur.

| Vérification | Résultat |
|---|---|
| Bootstrap | Installation, Chromium, syntaxe et démo OK; **136/136 tests passent** |
| Navigation initiale | 8 pages × 2 tailles: **14 observations, 2 blocages** |
| Contrôles principaux | **73 configurés: 58 réussis, 3 échoués, 12 non exécutés** |
| Worker réel | gpt-6.1-sol, **2 décisions**, ouverture des statistiques, arrêt au plafond; aucune relance |
| Consommation | **28 515 tokens** entrée + sortie déclarés; coût facturé inconnu |

## Relais au constructeur du harnais

**H01 · P1 — Limite d’intégration: plafond DOM.** Reproduction: mission page-0-college, desktop.json ou mobile.json. Observé: 216 contrôles DOM, dont 95 rendus, plafond 200; erreur « DOM control cap reached; observation refused ». Attendu: observer la vue active avec un budget documenté. Impact: le rôle Collège reste hors couverture. Prévoir un budget configurable et borné ou une observation par section active, sans supprimer les protections. Preuves: pilot.json, desktop/report.json, mobile/report.json. Code: src/browser.mjs:51. **Ce blocage n’est pas un défaut de la maquette.**

**H02 · P2 — Le nom exact d’un lien est tronqué.** Reproduction: long-name.json, clic sur la carte Secrétaire avec son nom accessible complet. Attendu: ouvrir la page; observé: nom réel de 180 caractères, observation limitée à 160, « expected control absent or ambiguous ». Impact: un scénario conforme au contrat des noms exacts échoue. Séparer le nom de résolution interne du texte borné envoyé au worker. Acceptation: le clic de 180 caractères réussit. Preuves: long-name-values.json et long-name/report.json. Code: src/browser.mjs:69, src/engine.mjs:302.

**H03 · P2 — L’exploration ignore les assertions UI.** Reproduction: worker.json, assertion sans-erreur-js; puis contre-épreuve assertion-control.json avec une décision finish synthétique. Attendu: assertion évaluée; observé: not-run même quand l’exploration termine en observed, tandis que le scénario écrit équivalent produit pass. Impact: la configuration ne donne pas la couverture demandée. Mutualiser l’évaluation des assertions; garder not-run lorsqu’aucune preuve n’existe. Preuves: worker/report.json et assertion-control/report.json. Code: src/engine.mjs:293, 310, 323. Le rapport signale honnêtement ce manque; aucun succès n’est fabriqué.

**H04 · P2 — Usage token rapporté à zéro.** Reproduction: comparer les événements worker-usage 15 et 30 avec worker/report.json. Attendu: (13 878 + 70) + (14 507 + 60) = **28 515**; observé: reportedTokens = **0**. Impact: consommation trompeuse. Normaliser input_tokens + output_tokens lorsque total_tokens est absent, sans recompter le cache; afficher indisponible si aucun compteur n’existe. Preuves: événements conservés dans le run worker; compteurs repris dans report.json adjacent. Code: src/engine.mjs:146. Limite: déclaration CLI, pas facture USD.

**H05 · P2 — Les échecs UI nécessitent une synthèse manuelle.** Reproduction: lire les trois sans-debordement=fail dans mobile/REPORT.md et report.json. Attendu: problème, reproduction, attendu/observé, impact et limite directement exploitables. Observé: coverage ne conserve que verdict et IDs; aucun bloc de défaut dans hypotheses. Les booléens overflow existent dans observations, mais il faut les rapprocher de la configuration. Impact: le constructeur doit reconstruire le diagnostic. Enrichir les assertions UI et leur rendu, sans les promouvoir en preuves métier. Code: src/engine.mjs:293, src/report.mjs:41. Les readChecks ont déjà un format plus riche.

## Relais au constructeur OraEtLabora

**O01 · P2 — Navigation et contexte coupés sur mobile.** Reproduction: viewport **390 × 844**, ouvrir Comité, Informaticien et Secrétaire. Attendu: document ≤ 390 px, avec défilement interne des grands tableaux. Observé: **1089, 898 et 801 px**; les captures montrent des menus et bandeaux hors écran. Faire revenir ces éléments à la ligne. Acceptation: le contexte reste visible à 390 px; seul le tableau défile si nécessaire.

Preuves UI: **44f79267-cac0-4eb0-8ad5-00fbc92e2e0a**, **9c376a48-a55b-4956-a7e7-55416ec8e082**, **cdfe1188-6db9-4120-8880-f01b541c23aa** (run mobile). Le débordement Collège mesuré en complément n’est pas compté comme un quatrième défaut confirmé: sa capture est bloquée par H01.

## Succès observés et limites

Consultations fictives valide, inconnue et incomplète: contrôles RPC réussis. Commentaire local conservé après rechargement: preuve **2c9752f3-18c7-498d-a3c1-da3ebace2969**. Saisie de « 12,5 » puis effacement: la cellule reste vide, preuves **ed0b3e4a-1090-4768-90ee-2d050b9b952a** et **1eff1891-14e9-4d8a-8e9d-3072867f0a20**. États refusé, erreur et validé accessibles; fill est refusé sur une note validée.

Les rôles sont simulés par les pages, avec une session moteur visitor. **Aucune isolation serveur, persistence métier, règle de calcul, impression A4, lecteur d’écran ou navigation Tab/Entrée validée.** Les 28 écrans et 21 documents n’ont pas tous été parcourus. Deux décisions réelles ne mesurent pas la qualité autonome. Les assertions sans-erreur-js portent sur l’observation finale, pas sur tout le parcours.

Codes de sortie: desktop 4; mobile 3; RPC 4 après refus de fill; revue/notes 0; worker 4 pour assertion non exécutée; nom long 4. Les tentatives bloquées et les contrôles non exécutés restent conservés. Une fixture complémentaire a été arrêtée avant réservation pour identifiant worker incorrect; aucun appel LLM, journal préservé; le contrôle corrigé est distinct.

**Ordre recommandé:** H02/H03, puis H04/H05; résoudre H01 et compléter Collège dans une nouvelle campagne; corriger O01 dans la maquette. Les critères d’acceptation détaillés, reproductions, valeurs, statuts et chemins de preuves figurent dans [report.json](report.json). Les preuves brutes restent privées dans artifacts\oraetlabora-20261013; ne pas publier les journaux ni les sorties CLI.
