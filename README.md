# Nebula Craft — panel Bedrock mono-instance

Panel privé pour gérer un seul Bedrock Dedicated Server dans le conteneur fourni. L’application ne lance pas Docker et ne produit aucun Dockerfile. Le monde est volontairement détruit à chaque déploiement.

## Démarrage dans le conteneur existant

Prérequis : Node.js `^20.19.0` ou `>=22.12.0` (Node 22 recommandé), Linux x64, glibc >= 2.29, `libcurl.so.4`, et le daemon `playitd` de Playit Agent 1.x dans le `PATH` si le tunnel doit démarrer. Le ZIP Bedrock est téléchargé depuis `data/versions.json`.

```bash
cp .env.example .env
# Définir au minimum PANEL_TOKEN et PLAYIT_SECRET_KEY dans .env ou dans les secrets du conteneur.
npm install
npm run build
npm start
```

Le serveur HTTP écoute sur `0.0.0.0:${PORT}` (3000 par défaut). En production, place-le derrière une terminaison TLS : les routes interactives refusent HTTP et les cookies de session sont `Secure`. Si le panel est derrière un reverse proxy, configure `PANEL_TRUST_PROXY` avec le nombre de hops ou les IP/CIDR exacts ; ne fais confiance qu’à un proxy inaccessible directement par les clients. Configure `PANEL_ORIGIN` si l’origine publique ne peut pas être inférée. En développement, `npm run dev` lance Express et Vite dans le même processus sans obligation HTTPS. Le frontend et l’API utilisent la même origine.

Variables principales :

| Variable | Rôle |
|---|---|
| `PANEL_TOKEN` | Jeton de connexion du panel ; échangé contre un cookie HttpOnly. Obligatoire pour s’authentifier. |
| `PLAYIT_SECRET_KEY` | Clé hexadécimale de l’agent Playit, consommée côté serveur uniquement. |
| `PLAYIT_BIN` | Chemin ou nom du daemon Playit Agent 1.x (`playitd` par défaut ; le CLI `playit` seul ne suffit pas). |
| `PORT` | Port HTTP du panel (`3000` par défaut). |
| `DATA_DIR` | Dossier JSON/logs, relatif à la racine du projet par défaut (`./data`). À monter en persistant. |
| `BEDROCK_SERVER_DIR` | Dossier Bedrock wipé à chaque Deploy (`./bedrock/server` par défaut). À monter en inscriptible. |
| `PANEL_ORIGIN` | Origine publique exacte, si le reverse proxy ne conserve pas le Host ou si l’origine externe ne peut pas être inférée. |
| `PANEL_TRUST_PROXY` | `0` par défaut ; nombre de hops ou liste d’IP/CIDR. À configurer uniquement pour les proxies qui sont réellement de confiance. |
| `BDS_START_TIMEOUT_MS` / `BDS_STOP_TIMEOUT_MS` / `PLAYIT_START_TIMEOUT_MS` / `PLAYIT_ADDRESS_TIMEOUT_MS` | Délais de démarrage et de détection Playit bornés. |

`data/versions.json` est un catalogue édité manuellement. Il faut redémarrer le panel après l’avoir modifié. Chaque entrée doit pointer vers un ZIP Linux HTTPS sur le domaine officiel Minecraft.

### Catalogue de test

Le catalogue initial contient la version demandée : `1.19.50.02`, avec l’URL du ZIP fournie pour le test. La sandbox de développement ne permettait pas d’effectuer une requête HTTP directe à Minecraft ; l’URL n’est donc pas déclarée « vérifiée en ligne ». Au Deploy, le backend exige HTTP 200, une taille non nulle, une signature ZIP et une extraction sûre avant de lancer le binaire. Une URL indisponible fait échouer le pipeline et n’entraîne jamais le démarrage d’un serveur partiel.

La page d’historique du wiki est une référence de versions, pas un catalogue garanti d’archives. Les versions anciennes doivent être ajoutées individuellement avec leur URL Linux officielle vérifiée ; aucun lien de téléchargement n’est fabriqué à partir du seul numéro de version.

## Données et comportement

- `data/state.json` : états de pipeline, dernière configuration, état/adresse Playit et statut des vérifications. Aucun secret Playit ou `PANEL_TOKEN` n’y est écrit.
- `data/server.log` : fichier tournant limité à 10 Mio, avec une copie `.1`.
- `bedrock/server/` : entièrement supprimé avant chaque déploiement ; ce dossier ne doit pas être versionné.
- `server.properties` : toutes les valeurs sont générées par le backend. `server-port=19132`, `server-portv6=19133`, `online-mode=false` et `allow-list=false` sont verrouillés.
- `permissions.json` : créé uniquement depuis 1 à 3 XUID numériques uniques.
- `allowlist.json` et `whitelist.json` : supprimés après extraction et jamais recréés.

L’interface demande une confirmation explicite avant le Wipe et indique le dossier Bedrock ainsi que les estimations d’espace disque. Le backend garde aussi un verrou anti-concurrence et renvoie HTTP 409 à une deuxième requête Deploy. Un arrêt du panel annule le pipeline et attend son nettoyage ; un échec d’arrêt de Bedrock empêche le Wipe. Un échec de déploiement n’essaie pas de lancer le serveur dans un dossier incomplet.

## Playit et console

Playit Agent 1.x est lancé **une seule fois au démarrage du panel** en exécutant `playitd` directement (sans lancer le CLI ni Docker imbriqué). Le panel suit l’état et l’adresse via l’IPC local du daemon ; Deploy et `/stop` ne l’arrêtent pas. Si le processus sort, il n’est pas relancé automatiquement et l’ancienne adresse est effacée. L’intégration cible le protocole IPC version 2 et les domaines Playit reconnus ; son fonctionnement avec le binaire installé dans le conteneur doit encore être confirmé. **Playit 0.17.1 n’est pas pris en charge par ce chemin** : il n’y a pas de repli vers l’ancien CLI ou son flux de logs. Utiliser `playitd` d’une version 1.x compatible avec IPC v2 ; un adaptateur 0.17.1 demanderait une implémentation et des tests séparés.

Le secret n’est pas placé dans les arguments du processus ni dans `data/state.json`. Le panel le transmet à `playitd` par un fichier temporaire, créé dans un répertoire privé avec les permissions `0700` et `0600`, puis tente de le supprimer dès que le daemon confirme l’avoir chargé ; le répertoire est aussi nettoyé à l’arrêt. Pendant le bref démarrage, un processus exécuté sous le même UID peut toutefois lire le fichier ; un arrêt forcé avant la confirmation de chargement peut le laisser dans le répertoire temporaire du conteneur.

La console WebSocket (`/api/server/console`) vérifie le cookie de session et l’Origin lors du handshake. Les commandes reçues sont écrites directement sur stdin de `bedrock_server` ; aucune entrée utilisateur n’est passée à un shell.

## Sécurité

- Jeton comparé en temps constant après hachage ; le placeholder de `.env.example` est refusé et un jeton de moins de 32 octets déclenche un avertissement. Cookie de session `HttpOnly`, `SameSite=Strict`, durée de 12 heures ; `Secure` en production.
- HTTPS est requis en production pour l’interface et les routes interactives. Les en-têtes proxy ne sont pris en compte que si les hops/IP/CIDR correspondants sont explicitement déclarés.
- Origine/Referer contrôlée sur login, logout, Deploy et Stop.
- WebSocket console authentifié séparément pendant l’upgrade.
- Le catalogue de versions n’est jamais accepté depuis une requête client.
- Aucun endpoint ne renvoie `PLAYIT_SECRET_KEY` ni `PANEL_TOKEN`.

## Contrôles et limitations connus

Le précontrôle est exécuté **dans le conteneur**, pas sur l’hôte Docker inaccessible. Il bloque un Deploy si Linux x64, glibc ou `libcurl.so.4` manquent, avant le Wipe. Le niveau mémoire inférieur à 4 Go est un avertissement seulement, conformément au choix « essai autorisé » ; un OOM reste possible. La page officielle BDS liste 4 Go dans ses prérequis, tandis que sa FAQ indique aussi 1 Go pour de petits serveurs — les 2 Go alloués ne garantissent donc pas le succès. Le panneau affiche aussi l’espace disque détecté.

Les points suivants ne peuvent pas être confirmés dans cette sandbox et restent à vérifier dans le conteneur cible :

1. **Archive Bedrock 1.19.50.02** : le lien fourni est inscrit au catalogue, mais sa disponibilité, son statut HTTP, son empreinte ZIP et son extraction réelle n’ont pas été vérifiés ici.
2. **EULA et cycle de vie BDS** : le formulaire exige une confirmation de l’opérateur ; le backend ne répond `y` que si un prompt interactif reconnu apparaît et n’invente pas de fichier EULA. Le prompt réel, l’arrêt gracieux, la sauvegarde du monde et le comportement en cas d’arrêt forcé nécessitent un essai avec le binaire ciblé.
3. **XUID avec `online-mode=false`** : les opérateurs sont générés dans `permissions.json`, mais leur reconnaissance/persistance après un deuxième Deploy n’a pas été vérifiée empiriquement. Le code ne remplace pas silencieusement `online-mode=false`.
4. **Playit** : l’intégration cible le daemon Playit Agent 1.x (`playitd`) et son IPC local version 2. Le binaire exact, son démarrage dans ce conteneur, l’affichage de l’adresse par cet IPC et l’arrêt réel n’ont pas été testés ici ; confirme-les avec la version installée.
5. **Espace et ressources** : le précontrôle estime le disque disponible par volume et avertit si l’espace semble insuffisant, sans réserver cet espace ; les quotas dynamiques du conteneur et la marge réelle nécessaire restent à mesurer.

Pour le premier essai, déployer une configuration avec `allow-cheats=true`, se connecter avec le compte correspondant, vérifier Operator en jeu/console, puis redéployer et refaire le contrôle. Les tests automatisés locaux se lancent avec `npm test`, les types avec `npm run lint` et la compilation avec `npm run build`.
