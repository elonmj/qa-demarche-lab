# Proposition de service web — non déployée

Choix proposé : interface de configuration/rapport, API authentifiée, queue, PostgreSQL pour états/budgets, stockage objet privé et un job isolé par campagne. Chromium s'exécute côté worker, jamais dans le serveur web qui porte les comptes des clients. Première ouverture : bêta fermée, uniquement environnements de recette appartenant aux utilisateurs, lecture seule. Les écritures viennent ensuite avec consentements granulaires et preuves de possession de la cible.

## Déploiement concret à réaliser

API légère et workers conteneurisés sur un projet cloud **neuf**, indépendant de tout projet applicatif existant. [Cloud Run Jobs](https://docs.cloud.google.com/run/docs/create-jobs) est un candidat pour les exécutions bornées ; utiliser limite de durée, ressources, compte de service minimal et retries de job à zéro. Une queue rejouée ne doit jamais réexécuter un geste : seul le journal transactionnel décide. Les [timeouts de tâches](https://docs.cloud.google.com/run/docs/configuring/task-timeout) sont une limite d'exécution, pas un oracle d'échec métier.

Il faut remplacer le Store fichier/lock PID par transactions SQL, réservations de coûts atomiques et fencing tokens. Un lease expiré ne prouve pas qu'un ancien navigateur a cessé d'écrire : terminer worker/egress, vérifier intentions, puis reprendre en réconciliation. Partager uniquement les budgets atomiques, jamais les contextes de navigateur entre tenants. Le journal fichier actuel ne doit pas être posé sur un filesystem partagé en guise de base multiutilisateur.

Chaque job reçoit uniquement sa mission signée et sa session chiffrée à durée courte ; aucun jeton cloud ou fournisseur dans le navigateur/site. Gateway modèle séparé, sans outils, impose limite de tokens/coût fournisseur et réserve SQL AVANT appel. Pas de fallback ni achat de crédits. Secret de compte recette dans un coffre dédié par tenant ; injection en mémoire, révocation à la fin, pas d'image Docker personnalisée par l'utilisateur ni shell/code fourni par lui.

Réseau : proxy d'egress imposé, résolution DNS et contrôle d'IP à chaque connexion/redirect. Bloquer localhost, réseaux privés, metadata cloud, rebinding DNS, IPv6 équivalent et origines non consenties. Cette règle diffère volontairement des fixtures loopback locales. Un [raccord VPC](https://docs.cloud.google.com/run/docs/configuring/vpc-direct-vpc) facilite le routage ; ce n'est pas à lui seul un filtre SSRF ou une isolation Chrome certifiée. Évaluer aussi gVisor/microVM et sandbox Chromium, WebRTC, popups, téléchargements, CPU/RAM/disque et navigateur hostile. La route Playwright seule ne suffit pas comme frontière hostile.

Stockage : artefacts dans bucket privé par préfixe tenant/job, chiffrement, ACL serveur vérifiée sur chaque lecture, URL signée courte seulement après autorisation. Rapports exports revus avant partage. Proposer rétention 7 jours de captures et 30 jours d'états/budgets avec suppression au choix ; une intention non rapprochée exige confirmation avant effacement pour éviter un rejeu oublié. [Lifecycle du stockage objet](https://docs.cloud.google.com/storage/docs/lifecycle) aide l'expiration mais une preuve métier retenue ou supprimée doit rester clairement expliquée. Ajouter log d'accès et tests de séparation intertenant.

## Coûts et limites proposés

Formule : appels × coût maximal par appel + secondes de CPU/RAM + stockage/requêtes/egress + API/SQL/observabilité. Paramètres de bêta proposés, pas tarifs garantis : 20 décisions/run, cap 0,02 USD/décision donc 0,40 USD réservé modèle/run ; un navigateur, 1 vCPU/2 Gio à tester, 5 minutes, 50 Mio d'artefacts et 500 requêtes réseau. Qualité/performance d'un modèle à ce cap non mesurées. Interruption automatique sans perte des intentions à la première borne atteinte.

À partir des [tarifs Cloud Run Jobs](https://cloud.google.com/run/pricing) affichés pour la région de référence : CPU 0,000018 USD/vCPU-s, mémoire 0,000002 USD/Gio-s. Hypothèse 300 s, 1 vCPU, 2 Gio : `300 × (0,000018 + 2 × 0,000002) = 0,0066 USD` de calcul brut/run, avant réseau/stockage/SQL/services/taxes et hors gratuité. Ce calcul illustre une enveloppe, pas un devis ni une mesure d'exécution hébergée. Le modèle domine souvent ce scénario hypothétique, pas forcément un scénario long de navigation sans LLM.

Alternative à essayer : Browserbase pour le navigateur géré. [Tarif consulté](https://www.browserbase.com/pricing) Developer 20 USD/mois, 100 heures puis 0,12 USD/heure ; modèle, proxies et limites de rétention séparés. Cela réduit l'exploitation navigateur mais ajoute dépendance/contrat de traitement et ne remplace pas notre registre d'intentions. Aucun abonnement ouvert.

## Parcours à construire

Utilisateur choisit URL de recette, rôle/persona, objectif et lectures sûres ; vérifie les permissions affichées ; fixe plafond financier ; démarre et voit contrôles couverts/preuves nouvelles. Rapport distingue UI, lecture métier, lecture serveur et non testé. Aucune mention « testeurs humains », « certifié sécurisé » ou « meilleur outil ». Une incertitude affiche l'intention et ouvre une relecture/revue, sans recommander de répéter. Le tableau de bord, les endpoints hébergés, le système de consentement signé et la facturation n'existent pas encore.
