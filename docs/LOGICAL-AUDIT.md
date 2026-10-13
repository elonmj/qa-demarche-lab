# Audit logique — 13 octobre 2026

Base vérifiée après `git fetch` : `b1a51e9373794e55ce41f8af1d2bccf93f3cf173`, branche `codex/qa-reliability`, arbre initial propre. Travail limité au harnais local, avec sites, comptes de session et fournisseurs synthétiques. Aucun appel LLM réel, déploiement ou changement Colgate.

## Carte du moteur

| Entrée / composant | Décision autorisée | Faits et persistance |
|---|---|---|
| CLI `run/explore/reconcile`, API Engine, RPC `mission/step/act` | Choisir une mission/configuration autorisée ; les propositions externes restent en lecture seule | Même Engine exclusif, Store et politique réseau. La CLI et `mission` exécutent aussi `verifyChecks` ; les appels API/`step` isolés ne le font pas implicitement |
| Worker | Proposer une action, une hypothèse ou une fin d'exploration | Réservation fsync avant appel ; réponse validée distincte ; hypothèse distincte de la couverture |
| `execute` | Préparer, puis tenter le geste écrit sous consentement | Étape `attempted` avant geste, `observed` seulement après observation durable. Intention et hold avant soumission ; fermeture du consentement ensuite |
| Politique / navigateur | Autoriser des slots de transport exactement déclarés ; exécuter le geste sur un handle valide | Réservations persistantes ; HTTP/DOM dans les artifacts d'observation. Une réservation ne prouve pas l'envoi ou la réception serveur |
| Probes | Lire des attentes et corrélations du propriétaire sous le rôle de mission/intention | Lectures indépendantes conservées avec IDs ; verdict métier seulement si disponibles, dans le scope et sans verdict opposé concordant |
| Store / rapport | Append fsync sous lock ; projeter les faits et les contrôles absents | Journal autoritaire. Le rapport n'ajoute pas de lecture au journal en affichant `not-run` |

## Invariants vérifiables

La portée commune ci-dessous est **un journal complet, intact, sous lock**, y compris son déplacement après arrêt du processus. Les répertoires sans ce journal ne partagent aucune autorité : voir le contrat manquant plus bas.

| Précondition → événement | État durable résultant | Actions encore permises |
|---|---|---|
| Proposition worker → validation | Réponse validée ou hypothèse ; aucune permission créée | Gestes en lecture seule ; soumission seulement par étape écrite consentie |
| Étape absente → réservation du geste | `steps[key].phase=attempted` avant geste | Observer ; ne jamais rejouer cette étape, même si aucune observation après geste n'existe |
| Préparations écrites observées → soumission | Intention `attempted`, hold et étape liés avant geste | Une fenêtre d'écriture sous caps ; puis rapprochement, sans second geste |
| Navigation/geste intermédiaire, cible remplacée ou absente à une observation → soumission demandée | Anciennes étapes restent dans le journal ; aucun nouvel intent | Lecture/revue. Même session ou modale similaire ne réhabilitent pas la préparation |
| Préflight indisponible, mauvais scope ou corrélation inconnue → soumission demandée | Aucune intention ni soumission créée | Corriger le prérequis hors campagne ou lire ; aucune absence métier déduite de l'inconnu |
| Intention incertaine → interruption/reprise/changement de contexte | Hold, rôle d'intention et réservations conservés | Rapprocher avec ce rôle ; session privée absente = arrêt, aucun repli anonyme |
| Toutes les probes disponibles → résultat corrélé unique | Verdict, preuves concordantes du tour décisif, hold retiré | Rapporter le verdict historique ; aucune nouvelle soumission de la même intention |
| Probes indisponibles, hors scope, sans corrélation ou contradictoires → rapprochement | `uncertain` et hold ; lectures conservées | Relire/revoir. Une nouvelle lecture disponible peut résoudre le conflit ; les anciennes contradictions restent historiques |
| Budget disponible → réservation worker puis arrêt/timeout | Calls/coût et `pendingWorker` conservés sans réponse validée | Lecture/rapport ; aucun nouvel appel ou fallback si réservation interrompue |
| Deadline atteinte → admission de geste/appel/envoi d'écriture | Aucun nouvel effet autorisé ; réservations antérieures conservées | Observations et rapprochement sous leurs propres caps. L'admission et l'envoi utilisent la même horloge de campagne |
| Perte de lock ou erreur de journal → nouvelle action | Store inutilisable ; dernière ligne durable reste l'autorité | Fermeture et revue ; pas de poursuite après retour du stockage |
| Contrôle configuré absent / geste non observé → rapport | Projection `not-run` / mission `attempted`, sans preuve fabriquée | Code 4, sauf priorité de l'intention pendante (2) ou d'un contrôle échoué (3). Une exploration réussie ultérieure ne masque pas le geste incomplet |

La deadline de campagne borne l'admission des gestes/appels et les nouveaux envois d'écriture ; elle n'est pas une garantie de terminaison physique de tout le processus. Bootstrap Chromium, gestes/captures déjà commencés et code tiers ont les bornes propres de leur adaptateur. Un fournisseur/probe ignorant l'annulation peut continuer en dehors de l'Engine ; son résultat tardif est écarté. Chaque échantillon `readChecks` est borné par `min(1500, probeTimeoutMs ?? 1500)` ms, y compris après deadline ; il y a deux échantillons par contrôle. La fenêtre de rapprochement métier est distincte. L'horloge injectée représente le temps de campagne ; quota et horodatages de journal restent en temps civil.

## Contre-exemples et corrections

Les IDs désignent les régressions de `tests/logical-audit.test.mjs`. Ce sont 16 reproductions regroupées sous 13 IDs, pas 16 classes indépendantes de défauts.

| Preuve | Comportement démontré sur la base | Correction et limite restante |
|---|---|---|
| L1 | Recréer un formulaire par RPC `act` dans la même session réutilisait les préparations originales | Préparations = suffixe ininterrompu des gestes écrits ; un geste externe intermédiaire exige revue |
| L2 | Une intention du rôle initial `owner-role` était relue comme `visitor` à la reprise | Rôle initial durable ; rôle de l'intention prioritaire pour les lectures. Les anciens journaux sans ce fait ne permettent pas de le reconstruire avec certitude |
| L3 | Reprise après verdict durable sautait une assertion UI et donnait code 0 | Contrôles absents explicitement `not-run`, code 4. Pas d'assertion réinventée contre une page reconstruite |
| L4 | Une exploration finie masquait une préparation sans observation durable | Mission `attempted`, dernier statut du passage conservé séparément ; aucun rejeu |
| L5 | `matched:true` primait sur `available:false` ou `scopeMatched:false` | Disponibilité et scope préalables au pass. L'adaptateur reste du code local de confiance, pas un oracle automatiquement honnête |
| L6 | Une probe custom lente hors deadline était acceptée par `verifyChecks` | Même borne/annulation que les autres lectures ; réponses tardives écartées, deux lectures indisponibles conservées |
| L7 | Verdict final citait aussi les anciennes lectures contradictoires | `outcomeEvidence` sélectionne les preuves concordantes du tour décisif ; conflit actif retiré quand résolu, historique intact |
| L8 (2 cas) | Contrôle remplacé à l'identique, ou disparu puis réapparu, accepté après relecture | Handle préparé retenu en mémoire ; identité, URL et présence aux observations contrôlées. Deux relectures du contrôle intact restent valides |
| L9 | API directe enregistrait une autre action sous l'ID d'une préparation écrite | ID écrit réservé à son étape et comparaison avec l'action écrite ; `authored` enregistré, exigé avant soumission |
| L10 | Avec horloge contrôlée, Engine et Policy n'expiraient pas la campagne ensemble | Horloge partagée pour admission et envoi. La modification de l'horloge civile externe n'est pas certifiée contre manipulation |
| L11 | Une assertion et un readCheck homonymes masquaient le contrôle non exécuté | IDs obligatoires/uniques dans la mission ; `business-outcome` réservé. Configurations legacy ambiguës lisibles en readback, rapport incomplet |
| L12 (3 cas) | `matched:true` sans corrélation pouvait confirmer ; corrélation inconnue pouvait être traitée comme absence au préflight | Corrélation positive explicite pour le résultat, booléen disponible pour le préflight, mauvais scope bloquant ; corrélation de la probe opposée disponible et cohérente |
| L13 | Valeur attendue correcte sur une autre entité présentée comme défaut produit par `readChecks` | Corrélation positive de l’entité exigée avant pass/fail ; mismatch = prérequis bloqué, aucune hypothèse produit ; corrélations configurées validées avant ouverture |

Les doubles de probes de A5 et du test de rôles ont été corrigés pour fournir une corrélation positive explicite. Leurs assertions restent inchangées : A5 continue de tester l'indisponibilité de l'oracle concurrent, plutôt que de passer simplement parce que la corrélation positive manque.

## Compatibilité et frontières d'observation

Format 2 et lecture des anciens snapshots conservés ; aucun reset, changement de hash de configuration ou migration automatique. Les champs `defaultRole`, `authored` et `outcomeEvidence` sont additifs. Les anciennes préparations restent invalides après changement de session ; les verdicts historiques restent historiques. Les anciens verdicts sans `outcomeEvidence` utilisent uniquement les preuves concordant avec leur phase pour l'affichage, sans recertification.

Les noms d'événement historiques `network-dispatched` et `safe-read-dispatched` sont conservés. Ils signifient **slot réservé avant transport**, désormais explicité par `facts.stage='reserved-before-transport'` et dans le rapport. `intent.requests` et `networkRequests` ne sont pas des compteurs de réception serveur. L'absence d'une réponse journalisée conserve l'inconnu.

Un contrôle préparé retenu n'est pas une preuve métier. Le moteur peut détecter son remplacement, sa disparition à une observation, un autre geste Engine ou un changement de contexte. Il n'atteste pas tous les changements transitoires entre observations, ni une réaffectation métier invisible d'un même nœud DOM. Une préparation asynchrone dont le contrôle de soumission n'est pas encore observable exige revue. Un adaptateur custom doit implémenter `retainReference/sameReference` pour une soumission précédée de préparation avec contrôle ; l'absence de ces méthodes bloque cette préparation. Les handles ne sont jamais persistés ou transmis au modèle.

La transportabilité d'une preuve exige un oracle du propriétaire : référence d'opération unique, liaison au corps consenti, scope vérifié (identité/rôle/entité/unité/date/statut pertinents) et sens précis des statuts. `scope` est une annotation ; `scopeChecks` ou checks métier explicites fournissent les comparaisons. Le préflight doit pouvoir vérifier son scope avant création de l'objet. Deux lectures HTTP non mises en cache ne prouvent pas, à elles seules, fraîcheur métier, absence de modifications concurrentes ou causalité exclusive. Un verdict vaut pour le moment de ses lectures et les checks déclarés ; il n'est pas une surveillance continue.

## Contrat manquant entre journaux distincts

Expérience exécutée : même fixture `before-request`, même configuration et `operationId`, deux répertoires vides. Chaque run admet un geste et conserve une intention incertaine ; le serveur reçoit zéro requête et ne connaît donc pas le premier geste. Preuve privée : `artifacts/directory-boundary-1791892790784/RESULTS.json`.

**Le moteur ne garantit pas l'exécution unique entre journaux indépendants**, ni leurs budgets communs. Déplacer le journal complet arrêté préserve les protections (régression dédiée) ; choisir un autre répertoire vide, repartir d'une ancienne copie ou supprimer l'autorité ne constitue pas une reprise. Le préflight n'est pas atomique et deux campagnes concurrentes peuvent lire la même absence avant de tenter chacune.

Contrat nécessaire pour élargir cette garantie : une autorité stable des tentatives partagée par toutes les campagnes qui peuvent viser l'opération, ou un serveur imposant atomiquement une clé d'idempotence et exposant un statut corrélé durable. Un registre purement local ne couvrirait pas un autre poste, une autre copie de l'installation ou sa suppression. Ce contrat n'est pas fourni ici ; aucun registre global ou système distribué ajouté. La consigne opérateur reste de conserver le journal, rapprocher et revoir avant toute campagne réellement distincte. Cette consigne n'est pas présentée comme un verrou intercampagnes.

## Vérification et portée

Résultats structurés : [logical-audit-evidence.json](logical-audit-evidence.json). Régression avant/après reproductible : copier le fichier de tests dans une archive de `b1a51e9`, puis `node --test --test-name-pattern '^L' tests/logical-audit.test.mjs`. Les 16 cas doivent échouer sur cette base et passer sur la correction. L'archive privée utilise la même dépendance Playwright 1.61.1.

Syntaxe, suite complète, démo, benchmark et contrôles visuels exécutés sous Windows / Node 24.14.1. Deux vrais processus tués à la réservation worker et après intention durable, en complément du SIGKILL navigateur après mutation et des huit exceptions injectées existantes. Une reprise conserve 123 micro-USD synthétiques et interdit un nouvel appel ; l'autre garde rôle/intention et ne rejoue aucun geste. Stockage indisponible, append partiel, lock perdu, concurrence et fournisseurs défaillants restent couverts par les régressions antérieures.

Les parcours valides continuent à sauvegarder exactement une fois ; captures mobile/desktop et DOM des deux fixtures vus, console sans erreur et aucun débordement horizontal. Masques roses et bouton volontairement occlus visibles ; total 21 pour lignes 12 + 8 volontairement faux. Lecture conceptuelle : le testeur voit l'incertitude et les contrôles absents ; le développeur peut retrouver les preuves du verdict ; le propriétaire voit réservations et portée du verrou. Cette lecture n'est pas un test avec de vrais utilisateurs.

Les durées du benchmark sont descriptives ; les 24 cas à seeds fixes ne mesurent pas l'autonomie d'un LLM. Aucun résultat Linux/CI distante, fournisseur réel, panne électrique, résistance d'un filesystem hostile, anonymisation exhaustive ou garantie intercampagnes revendiqué. Les protections dépendent du journal intact et du bootstrap/adaptateur local de confiance. La date de mesure du benchmark, auparavant figée au 8 octobre, provient désormais de son horodatage effectif UTC ; les dates métier des fixtures restent synthétiques et inchangées. Aucune dépendance ajoutée. Commit et push Git autorisés par le propriétaire après validation.
