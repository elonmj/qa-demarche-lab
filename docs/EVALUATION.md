# Évaluation reproductible — 8 octobre 2026

Windows, Node 24.14.1, Playwright 1.61.1, Chromium installé. Deux serveurs HTTP indépendants : atelier de commandes et registre documentaire. Tout est synthétique ; aucun accès, donnée ou preuve d'une application réelle utilisé.

## Résultats mesurés

Renforcement local après cette livraison : **63 tests sur 63 réussis**, zéro ignoré, en 62 019,565 ms. Les 21 régressions ajoutées couvrent validation, secrets échappés, store fermé/panne/écriture partielle, rôles RPC et probes, préparations de session, quota défaillant, preuves positives et codes de sortie avec fermeture malgré panne du rapport. Démo et syntaxe passent ; benchmark 8/8, zéro rejeu non autorisé/faux positif sur ces cas. Cette vérification est locale Windows ; aucun nouvel essai LLM, résultat Linux ou résultat CI distant revendiqué. Détails, sorties et limites dans [HARDENING.md](HARDENING.md).

Version 0.2 : **42 tests sur 42 réussis**, zéro ignoré, en 43 864 ms sur le poste de développement, puis 44 332 ms dans une copie indépendante avec ses propres dépendances. Contrôle de syntaxe et démo CLI également réussis ; démo `save-basic: confirmed`. Les nouveaux contrats couvrent parsers CLI, processus réel, quotas Codex, choix de workers et protocole JSON-RPC dans un vrai processus enfant. Aucun import du dépôt parent nécessaire.

Clone public neuf : `npm ci --ignore-scripts`, `npm run check` et `npm run demo` réussis, arbre Git propre. La CI est configurée pour syntaxe, tests et démo sur Windows et Linux. Sa première exécution n'a démarré aucun job, pour une restriction externe du compte GitHub : aucune validation Linux ni CI verte revendiquée. [Exécution initiale](https://github.com/elonmj/qa-demarche-lab/actions/runs/37807627028).

Deuxième benchmark complet, fichiers `artifacts/benchmark-1791468622476/RESULTS.json` et `RESULTS.md` dans le workspace de développement :

| Implémentation | Verdicts corrects | Durée totale mesurée | Appels LLM / coût | Rejeux non autorisés | Faux positifs de verdict |
|---|---:|---:|---:|---:|---:|
| QA Lab, scénarios écrits et preuves durables | 8/8 | 12 942 ms | 0 / 0 USD | 0 | 0 |
| Playwright écrit, même oracle métier | 8/8 | 6 473 ms | 0 / 0 USD | 0 | 0 |

Durées incluent démarrage et actions, pas toutes les fermetures de navigateur. Ordre fixe et charge machine variable : aucune signification statistique. Coût infrastructure local non chiffré. Zéro appel LLM dans ce benchmark signifie **absence de mesure LLM**, pas gratuité d'un agent de production. La suite de tests utilise des décideurs synthétiques, processus CLI factices et un gateway HTTP local ; les essais natifs séparés sont décrits ci-dessous.

Les huit cas : sauvegarde normale, persistance différée avec modal disparue, écriture réussie/réponse perdue, rejet HTTP 403, refus métier HTTP 200, deux écritures liées à un geste, faux toast sans requête, refus métier avant toute requête. Deux derniers restent incertains côté moteur faute d'oracle positif de résultat ; le DOM permet de distinguer leurs messages UI. La baseline partage le même contrat et borne de relecture ; elle n'est pas un benchmark Playwright Test Agents ou un outil SaaS autonome.

Trois anomalies semées sont observées : toast de succès sans persistance dans la fenêtre bornée ; total 21 pour lignes 12 et 8 ; document définitif passant de 2 à 3 pages après clôture. Les deux défauts du registre sont détectés par checks du propriétaire et deux lectures séparées, avec attendu/observé/impact dans rapports. Le faux toast reste une observation UI et une absence bornée ; pas de certitude universelle d'absence future. Couverture utile = huit contrats d'issue + contrôles du registre + non-régressions ci-dessous, pas nombre de sessions. Recall autonome et taux de faux bugs LLM non mesurés.

## Non-régressions

| Incident / invariant | Test exécuté | Conclusion limitée |
|---|---|---|
| Préparation/modale/soumission confondues | Local preparation + business oracle | Zéro intention et zéro requête avant confirmer |
| HTTP 200 pris pour succès | http200-refusal | Refus rapproché depuis registre indépendant |
| Timeout pris pour échec | timeout + reprise | Écriture retrouvée, une seule tentative |
| Bouton disabled après succès | basic | Formulaire vide, bouton toujours disabled, `busy:false`, succès indépendant |
| Multi-écriture = double soumission | multiple + caps | 2 requêtes consenties, un geste, zéro rejeu |
| Processus interrompu | vrai `SIGKILL` après écriture et avant rapprochement + reprise injectée | Lock persistant, vérification PID, reprise lecture seule, compteur conservé |
| Contrôles trompeurs | hidden/occluded/stale/replaced | Références refusées avant geste ; sliders/uploads/navigation exécutés |
| Quotas inconnus/épuisés | core + gateway HTTP | Aucun appel décision sans quota frais, réserve atteinte bloque |
| Budgets/reprise/fallback | réservation durable et verrou concurrent | Coût maximal retenu après erreur ; deuxième fournisseur refusé |
| Cycle/hallucination/injection | provider scripté sur navigateur réel | Couverture métier ne vient pas d'une affirmation ; limites d'état/appels |
| Unités/date/fuseau/compte/quantité | cinq probes volontairement incompatibles | Aucun faux succès malgré enregistrement présent |
| Provisoire/définitif et clôture | second site | Visa relu ; modification après clôture semée observée |
| Secrets de session et sélecteurs sensibles | canary synthétique, roles contexts | Aucun canary dans données modèle, journal, JSON/Markdown ; captures masquées, régions vues |
| Faux bug lors de lecture refusée | unavailable independent read | `blocked-prerequisite`, aucun candidat produit |
| Totaux/conservation/déduplication | owner checks + sum | Défaut arithmétique relu, invariant positif passe, candidat dédupliqué |

## Essais natifs CLI séparés

Plafond de recette cumulé : 12 réservations de décision, y compris les demandes refusées ; quota frais et réserve de 15 %, aucun achat de crédit ni fallback automatique. Les sorties brutes, sessions et compteurs privés du compte ne sont pas publiés.

- Antigravity/Gemini : le CLI installé annonce 60 outils natifs malgré la configuration sans outils. L'activation de la garde native n'a pas été attestée. L'adaptateur refuse ce profil ; aucune action navigateur acceptée. Cela établit un prérequis de compatibilité, pas une vulnérabilité du fournisseur. Gemini CLI distinct n'est pas installé ni évalué en live.
- Codex : campagne distincte explicitement configurée avec `gpt-6-luna`, quota lu via `account/rateLimits/read`. Deux décisions JSON valides ont effectivement navigué sur les routes synthétiques `/case/basic` et `/case/controls`. La troisième décision est arrêtée avant appel par le plafond cumulé. Rapport sans faute fournisseur, observations sans erreur console ni débordement ; aucune intention de mutation.

Ces deux décisions ne terminent pas une campagne autonome et ne mesurent ni rappel, ni faux bugs, ni coût USD réel. Les réservations mesurent les appels du harness, pas tous les traitements internes d'un fournisseur. Le compteur serveur indépendant ajouté au script pour les prochaines recettes n'était pas consigné sur ce run arrêté : aucune mesure rétroactive inventée. Aucun nouveau run modèle après épuisement du plafond.

## Visuel et conceptuel

`node fixtures/visual-qa.mjs` : quatre captures observées, DOM lu, console vide et `overflow:false` aux largeurs 390/1280 pour chacun des deux sites. L'occlusion de la commande est un piège synthétique intentionnel, exclu des actions ; champs masqués volontairement. Le total faux du registre est un défaut semé, pas une anomalie du rapport. Les fixtures ne sont pas l'interface publique du produit.

Trois personas adaptés à cet outil (aucun écran métier existant modifié) :

| Question observable | Testeur pressé | Développeur correcteur | Propriétaire |
|---|---|---|---|
| Le résultat distingue préparation, tentative et sauvegarde prouvée ? | Oui, états/journal | Oui, intention et probes | Oui, limites explicites |
| Une incertitude pousse-t-elle à répéter ? | Non, reconcile seulement | Non, lock/intention | Non, absence de retry/fallback |
| Les chiffres et preuves sont-ils traçables ? | Oui, rapport compact | Oui, JSON, captures et config | Oui, réservations entières et état durable |
| Le produit affirme-t-il de vrais humains ou une certification exhaustive ? | Non | Non | Non |

Ces réponses portent sur CLI et rapports observés. Ergonomie d'une interface web utilisateur et compréhension par de vrais utilisateurs non mesurées.

## Reproduire

```powershell
npm test
npm run benchmark
node fixtures/visual-qa.mjs
```

Sources des fixtures versionnées ; chemins de sorties timestampés pour ne pas écraser les runs. État de site en mémoire conservé pendant les tests de reprise, jamais reset au milieu d'une opération. Aucun compte de site réel ni benchmark SaaS exploité. Les essais CLI utilisent l'authentification normale des abonnements locaux, sans copie des credentials. Une fuite réelle ou un second geste non autorisé aurait fait échouer les assertions, pas diminué une moyenne.
