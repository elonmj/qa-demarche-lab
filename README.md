# QA Démarche Lab

Harnais local pour **agents simulant une démarche de QA humain**. Ils ne sont pas de véritables testeurs humains. Tout orchestrateur LLM avec des outils de processus peut cloner ce dépôt, choisir ses agents exécutants et piloter des missions QA. Playwright exécute les gestes ; le moteur impose les permissions, les budgets, les preuves et la reprise.

Version **0.2.0 beta**, code sous licence MIT. Deux sites synthétiques, tests de reprise/budgets et comparaison Playwright écrite. Codex CLI a produit deux décisions réelles et piloté le navigateur avant arrêt au plafond de recette ; cela ne mesure pas encore la qualité autonome. Le profil Antigravity/Gemini est expérimental et refusé sur le poste testé : 60 outils annoncés, garde native non attestée. Aucun service SaaS multiutilisateur n'est livré.

## Pour un orchestrateur LLM

Lire [AGENTS.md](AGENTS.md) puis [le guide d'orchestration](docs/ORCHESTRATION.md). Le modèle de l'orchestrateur est indépendant des workers : par exemple GPT-6 Sol orchestre et choisit un worker moins coûteux pour l'exploration. Le choix est explicite, jamais un fallback automatique.

```sh
git clone https://github.com/elonmj/qa-demarche-lab.git
cd qa-demarche-lab
npm ci
npx playwright install chromium
npm run demo
```

Copier `examples/agents.codex.json` ou un autre profil, définir sa cible de recette et ses lectures sûres, puis :

```sh
node src/cli.mjs agents site.json
node src/cli.mjs explore site.json artifacts/my-run
```

Changer `agents` et l'affectation `scenario.agent` pour choisir CLI/modèle. Adaptateurs : Codex, Antigravity, Gemini CLI, wrapper JSON générique et gateway HTTP. Les prérequis et statuts réellement essayés sont dans [ORCHESTRATION.md](docs/ORCHESTRATION.md). `agents` vérifie la présence du programme, pas sa compatibilité complète. La session JSON-RPC `serve` permet aussi à un orchestrateur externe de piloter directement les actions Playwright contrôlées.

## Essayer en cinq minutes

Node.js 22 ou supérieur. Depuis ce dossier (ou sa copie indépendante) :

```powershell
npm install
npx playwright install chromium
npm run check
npm test
npm run demo
```

La démo démarre uniquement un serveur loopback synthétique, prépare une commande, confirme une seule fois et relit le résultat. Elle affiche le chemin du rapport local. Aucun compte ou service distant nécessaire, aucun coût LLM.

```powershell
npm run benchmark
node fixtures/visual-qa.mjs
```

Le benchmark écrit `artifacts/benchmark-*/RESULTS.md` et les rapports de cas. La démo écrit `artifacts/demo-*/REPORT.md`, `report.json`, journal et captures privées. Les données synthétiques disparaissent quand le serveur de démo s'arrête ; une vraie reprise suppose que le site de recette conserve son état.

## Tester son propre site

Copier `examples/site.readonly.json`, renseigner origine, routes et ressources **connues sans effet de bord**, puis :

```powershell
node src/cli.mjs run my-site.json artifacts/my-run
```

Tous les chemins sont exacts. Une ressource, origine secondaire ou query inconnue est bloquée ; une application réelle requiert donc un inventaire réseau explicite. Le blocage observé est un prérequis/politique, pas automatiquement un bug du site. Cette version refuse les POST de lecture GraphQL et les WebSockets.

Les scénarios ont `id`, objectif, persona, rôle optionnel et étapes (`observe`, `navigate`, `click`, `fill`, `select`, `slider`, `upload`, `scroll`). Les cibles d'étapes écrites sont des noms accessibles exacts. Référence absente/ambiguë/remplacée : divergence de protocole, aucun contournement automatique. Voir `fixtures/sites.mjs` pour deux configurations exécutables sans dépendance métier.

Une étape `submit: true` exige un `writeConsent` confirmé avec motif, endpoints, méthodes et caps. Pour les API JSON, borner aussi `allowedFields` et `bodyChecks` aux entités/valeurs autorisées. La configuration de fixture illustre ces checks. Une probe lit un endpoint sûr et compare les chemins JSON déclarés (`equals`, `includes`, `sum`). Attendus et périmètre viennent du propriétaire, jamais du modèle. Probes `confirmed` et `rejected` doivent corréler la référence d'opération ; absence seule ne prouve pas le refus.

Après une interruption :

```powershell
node src/cli.mjs reconcile my-site.json artifacts/my-run
```

La même configuration est requise. Si le processus a été tué et son lock subsiste, vérifier sa sortie puis `node src/cli.mjs unlock artifacts/my-run`. La CLI refuse de déverrouiller un PID encore actif. Pas de compteur remis à zéro, pas de resoumission après rapprochement. Une nouvelle tentative exige une nouvelle autorisation et campagne explicitement distinctes après revue.

## Brancher un modèle

Pour une API facturée, ajouter à la configuration un champ `provider` conforme à `examples/gateway-contract.json`, puis définir volontairement `QA_LAB_GATEWAY_TOKEN` pour ce gateway de confiance. Pour un CLI, utiliser le registre `agents` des exemples. Aucune lecture de fichier .env. Lancer `node src/cli.mjs explore my-site.json artifacts/my-agent-run`. Exploration modèle strictement en lecture seule ; les écritures restent réservées aux étapes écrites et consenties.

Contrat gateway : `GET quotaEndpoint` retourne `{available:true,remainingFraction:0.9,checkedAt:timestamp_ms}` issu du quota réel ; `POST endpoint` reçoit `{model,maxCostMicros,input}` et retourne une seule décision JSON (par exemple `{action:"observe"}`). Il doit borner coût/sortie du fournisseur, ne pas refaire d'appel implicitement et ne donner aucun outil au modèle. Pas de gateway réel inclus ; l'adaptateur HTTP est testé contre un serveur synthétique. Sans quota frais, arrêt avant décision. Une réservation après timeout reste consommée ; un changement de fournisseur est refusé sur le même run.

Le modèle voit seulement la mission, le persona, les états factuels et une observation nettoyée sous `untrustedSite`. Il n'accède pas au filesystem, aux sessions ou au réseau directement. Les assertions de réussite deviennent hypothèses, jamais états certifiés. La couverture vient de checks exécutés avec preuves.

## Lire le rapport

`REPORT.md` donne état, contrôles, problème/reproduction/attendu/observé/impact ; `report.json` contient les lectures indépendantes, valeurs et périmètres. `uncertain` = relecture/revue, jamais bouton « réessayer ». Les captures sont masquées, les corps réseau et sessions ne sont pas enregistrés. Conserver les artifacts privés et les supprimer selon son besoin ; la rétention automatique locale n'est pas implémentée.

Chaque contrôle indépendant conserve ses deux lectures dans `coverage[].samples`, avec les IDs de preuve, valeurs attendues/observées et scopes disponibles, même lorsqu'il réussit ou que sa lecture est indisponible. Deux missions différentes restent deux contextes de défaut distincts.

Pour `run`, `explore`, `reconcile` et `demo`, la CLI fournit un code utilisable en CI :

| Code | Résultat |
|---|---|
| 0 | Exécution terminée sans contrôle échoué ou incomplet |
| 1 | Erreur d'exécution, de configuration ou d'instrumentation |
| 2 | Intention non rapprochée : conserver les preuves, ne pas resoumettre |
| 3 | Au moins un contrôle configuré a échoué |
| 4 | Contrôle bloqué/inconclusif ou circuit worker ouvert dans le rapport |

Une intention non rapprochée prime sur les autres contrôles. Le code 0 décrit les checks exécutés, pas une certification du site. `report` et `serve` restent des commandes de lecture/pilotage : examiner leurs verdicts JSON. Voir le [renforcement et ses critères](docs/HARDENING.md).

Pour les rôles authentifiés, utiliser l'API `Engine(config, directory, provider, {privateOptions})` et sessions en mémoire, comme expliqué dans [l'architecture](docs/ARCHITECTURE.md). SSO/MFA/bootstrap de compte sont à intégrer par le propriétaire hors modèle ; aucun accès de démonstration réel n'est fourni.

Lire [comparatif et recommandation](docs/COMPARISON.md), [mesures et méthode](docs/EVALUATION.md), [voie web et coûts](docs/WEB-PUBLICATION.md), [limites](docs/LIMITS.md). Dépôt public sous MIT ; `private:true` empêche une publication npm accidentelle. Aucun abonnement, crédit ou déploiement cloud créé.
