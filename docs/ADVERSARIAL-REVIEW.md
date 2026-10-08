# Revue indépendante du harnais — 8 octobre 2026

Base : dernière branche par défaut `refonte/guichet-qa-cli`, commit `5b70d19` (PR #1). Travail dans un clone indépendant, branche `codex/adversarial-harness-review`. Lecture de toutes les sources du moteur, adaptateurs, fixtures et tests. Aucun fichier Colgate, compte de site réel, appel LLM, abonnement ou déploiement utilisé.

## Défauts démontrés et corrections

Les mêmes **29 régressions A1–A29** sont exécutables sur la base et la correction. Elles ne représentent pas 29 classes indépendantes de vulnérabilités. Les groupes suivants regroupent les causes communes ; les autres tests existants sont conservés.

| Tests / preuve | Observé sur `5b70d19` | Impact et correction |
|---|---|---|
| A1, A22 | Deux gestes pour deux appels `execute` simultanés ; `start(role)` ferme le contexte d'un geste en cours. | Rejeu et confusion de rôle. API Engine exclusive, appels concurrents refusés, aucune file de retries. |
| A2, A3, A20, A29 | Préparation acceptée après deadline ; worker lent attendu 400 ms malgré plafond 160 ms ; probes dépassant 80 ms attendues ~1 s ; requête tardive autorisée. | Délais effectifs et coûts de campagne. Deadline à chaque geste et à l'envoi des écritures, fenêtre de collecte bornée, AbortSignal et borne de lecture partagée. |
| A4, A21 | Réservation durable interrompue suivie d'un autre appel ; rapport code 0 malgré réservation non résolue. | Retry implicite/coût inconnu. Marqueur `pendingWorker`, aucune nouvelle décision, code 4. Réservation conservée. |
| A5 | Probe `confirmed` positive et probe `rejected` indisponible donnent `confirmed`. | Faux résultat métier. Toutes les lectures doivent être disponibles ; contradictions restent `uncertain`. |
| A6, A19 | Status ancien suffisant ; opération déjà présente attribuée à un geste sans requête. | Preuve sans causalité. `operationId` et corrélation explicites, vérification préalable de non-présence avant intention/geste. |
| A7 | `scopeChecks` ignorés ; total d'un autre compte promu en défaut produit. | Faux positif. Vérification de scope dans la réponse ; mismatch = prérequis bloqué. `scope` seul reste une annotation propriétaire. |
| A8, A9, A13 | Canary dans attendu/journal/rapport, chemin d'action et mission envoyée au worker ; préfixe de secret coupé avant masquage ; ID RPC objet brut renvoyé. | Fuite. Masquage des attentes/scopes/actions/payload worker, masquage avant troncature, validation et nettoyage des IDs. |
| A10–A12 | Corps entièrement accumulés avant cap ; finding structuré sans plafond. | Mémoire/sortie non bornées. Lecture streaming avec annulation : gateway/quota/décision 20 000 octets, probe 100 000 ; décisions de tous les adaptateurs 20 000. |
| A14–A16 | Ligne RPC sans fin non bornée ; init Gemini absente/error ignorée ; UTF-8 fractionné corrompu (`é` → `��`). | Blocage/protocole/preuve altérée. Framing borné avant EOF avec backpressure, parser plus strict, décodage incrémental. |
| A17, A23–A26 | Copie complète de chaque état dans le cache et journal ; captures et contrôles DOM sans plafond. | Coût cumulatif. Deltas durables, cache de 256 métadonnées, observations légères ; réservations persistantes de captures et octets avant écriture ; refus du DOM excessif. |
| A18 | Rapport écrasé après perte de lock. | Écriture par un ancien propriétaire. Vérification du lock avant rapport et aux frontières asynchrones. |
| A27, A28 | Objets JSON équivalents selon ordre des clés déclarés différents ; NaN accepté puis transformé en null par clonage. | Faux défaut/contrat modifié. Égalité structurelle, attentes JSON finies validées. |

Reproduction : copier `tests/adversarial.test.mjs` dans une copie détachée de `5b70d19`, installer ses dépendances, puis `node --test tests/adversarial.test.mjs`. La base doit échouer ; ce n'est pas un résultat vert attendu. La branche corrigée doit passer les mêmes assertions. Aucun test désactivé, aucune assertion de recette relâchée.

Les huit interruptions injectées de `tests/recovery.test.mjs` portent sur préparation avant/après geste, préflight, intention, réservation réseau, fermeture du consentement, lecture indépendante et verdict durable. Le compteur de la fixture survit au redémarrage ; aucun second geste. Ce sont des fautes injectées, distinctes du test SIGKILL réel existant après mutation. Panne après écriture partielle, legacy ledger et échec de bootstrap de rôle sont aussi vérifiés.

## Validation et mesures

Résultats finaux et chemins locaux : [preuves de validation](review-evidence.json). Les captures, journaux et sorties brutes restent privés sous `artifacts/` et sont exclus de Git.

- `npm run check`, `npm test`, `npm run demo`, `npm run benchmark`, `node fixtures/visual-qa.mjs` exécutés sous Windows / Node 24.14.1 / Chromium Playwright 1.61.1.
- Suite finale : **107/107**, zéro ignoré, 70 698,4783 ms. Même fichier de 29 régressions (SHA-256 consigné) : **0/29** sur la base, **29/29** dans la suite corrigée. Les 63 tests antérieurs restent présents.
- Après ouverture de la PR, les jobs Windows/Linux GitHub ont échoué **avant toute étape** : annotation « The job was not started because your account is locked due to a billing issue. » [Run concerné](https://github.com/elonmj/qa-demarche-lab/actions/runs/37818380570). Aucun log de test distant, aucune validation Linux/CI revendiquée et aucun achat ni relance pour contourner ce blocage.
- Démo : `save-basic: confirmed`, une seule écriture consentie.
- Benchmark historique : 8/8 pour les deux implémentations, zéro rejeu non autorisé ; durées descriptives, aucune conclusion statistique.
- Évaluation supplémentaire : seeds 17, 2026, 8675309, 24 cas (totaux, unités, données, ordre, latence, indisponibilité, JSON malformé et lectures instables). Défauts cachés au décideur scripté : 6 vrais positifs, 0 faux négatif, 0 faux positif parmi 18 contrôles négatifs ; 12 résultats bloqués/inconclusifs. La matrice est calculée et un test lui injecte volontairement deux faux positifs et un faux négatif. Aucun rappel LLM/autonome mesuré.
- Profil Store, 60 observations de 10 000 caractères : journal **18 370 801 → 625 206 octets**, cache JSON **18 370 802 → 15 347 octets**, durées **1 170 → 607 ms** sur ces deux exécutions locales. Profil corrigé à 500 observations : **5 207 728 octets**, **24 412 ms**, pic heap échantillonné **148 945 392 octets**. Ce dernier chiffre dépend du GC et ne borne pas le RSS ; les snapshots/diffs coûtent encore du CPU et de la mémoire en fonction de l'état courant.
- Quatre captures 390/1280 pixels observées ; DOM et console lus : aucune erreur, aucun débordement horizontal. Masques roses et occlusion volontaire visibles ; total 21 pour 12 + 8 volontairement faux. Ni audit esthétique exhaustif ni anonymisation d'images/canvas inconnus.

Un essai intermédiaire à parallélisme Node par défaut a produit deux timeouts `fill` (1 200 ms) sous charge Chromium. Deux fichiers concurrents ont ensuite passé des suites complètes, mais un autre essai a encore échoué sur le premier `fill`. Le runner final exécute les fichiers séquentiellement ; les tests de concurrence API restent explicitement concurrents à l'intérieur de leurs tests. Aucun timeout du moteur ni protection augmenté. La sensibilité aux machines chargées reste une limite. Un premier essai du nouveau benchmark s'est arrêté sur sa propre garde trop large (`unavailable` trouvait la phrase « Credentials are unavailable ») ; garde corrigée pour rechercher une valeur JSON de vérité exacte, métriques ensuite recalculées. Ces échecs ne sont pas masqués comme résultats verts.

## Compatibilité et utilisation

- Profils publics de lecture seule inchangés. Nouvelles écritures : chaque probe doit corréler exactement `scenario.operationId`. `equals` compare une référence ; `includes` de corrélation exige une liste de références, jamais une sous-chaîne libre. Le propriétaire doit aussi lier cette référence au corps/endpoint consentis.
- Référence déjà présente ou lecture préalable indisponible : arrêt avant geste. Ce préflight ne fournit pas une transaction atomique entre deux campagnes distinctes ; un identifiant propriétaire unique et un oracle fiable restent nécessaires.
- Ancienne campagne : garder configuration, journal et autorisations inchangés. `reconcile` et `report` acceptent les anciennes configurations en lecture seule. Une ancienne intention sans corrélation reste incertaine ; aucun geste ni appel worker. API : `{readbackOnly:true}`. Les anciens verdicts déjà journalisés sont historiques, pas recertifiés rétroactivement.
- Journal format 2 : lit les snapshots historiques puis ajoute des deltas hashés/fsync. Le binaire précédent refuse sa sentinelle de configuration, plutôt que de remettre les budgets à zéro. Pas de downgrade ni modification manuelle du journal. `Store.events` devient un cache de 256 métadonnées ; l'historique intégral reste dans `ledger.jsonl`.
- `state.observations` contient les résumés ; texte/contrôles restent dans les JSON privés de captures. Plafonds : 250 tentatives d'observation et 64 Mio de nouvelles captures par défaut, configurables avant campagne (`maxObservations`, `maxArtifactBytes`) ; aucun reset à la reprise. 200 contrôles DOM, 20 000 nœuds texte inspectés, 100 000 caractères visibles collectés. Dépassement = limite d'instrumentation, pas défaut du site.
- Les extensions de fournisseur doivent respecter le `signal` reçu. Un adaptateur custom qui ignore l'annulation peut continuer son propre traitement ; l'Engine refuse son résultat tardif et garde son circuit/coût, sans garantir la terminaison physique de logiciel tiers.

## Contrats officiels et niveau de preuve

Documents consultés le 8 octobre 2026 : [Codex exec et JSONL](https://learn.chatgpt.com/docs/non-interactive-mode), [Codex app-server](https://learn.chatgpt.com/docs/app-server), [Gemini headless](https://geminicli.com/docs/cli/headless/), [Gemini configuration](https://geminicli.com/docs/reference/configuration/), [Antigravity headless](https://www.antigravity.google/docs/cli/headless/).

Codex documente les événements de tour et l'interface de lecture des quotas ; Gemini documente init/messages/result et les allowlists d'outils ; Antigravity documente init/step_update/result et les compteurs de tours cumulatifs. Ces pages ne prouvent pas l'isolation du poste, le prix réel, le modèle disponible sur un compte ni l'activation d'un hook. Les sorties/processus CLI et gateway de cette revue sont factices et locaux ; aucun nouvel essai fournisseur réel. La limite Antigravity précédente reste intacte.

## Travail restant

L'isolation intertenant, SSRF/DNS, l'egress natif et les intégrations fournisseurs vivantes ne sont pas certifiés. `route.fetch` Playwright peut encore bufferiser des ressources de page avant fulfillment : les caps JSON/DOM ne constituent pas une borne mémoire globale de Chromium. Les anciens artifacts sans compteur d'octets ne sont pas reconstruits automatiquement ; leur inventaire/rétention exige revue. Les changements d'intents, steps et visits restent remplacés dans les deltas ; le CPU de diff dépend de tout l'état, et aucune campagne de plusieurs jours n'est mesurée. Les PII/secrets inconnus ou encodés arbitrairement, canvas/images et modifications externes du serveur échappent à cette validation. L'oracle transport n'est pas une source automatiquement honnête. Ni perfection ni autonomie générale revendiquée.
