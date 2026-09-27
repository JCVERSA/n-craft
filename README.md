# Nebula Craft — panel Bedrock mono-instance

Panneau privé pour **une seule instance Bedrock Dedicated Server** dans le conteneur Linux déjà fourni. L’installation et l’exécution ne lancent pas Docker, n’ajoutent pas de Dockerfile et n’utilisent pas de base de données. Les réglages, l’état, les journaux et les fichiers des fournisseurs de tunnel sont gardés dans des fichiers locaux ; le dossier `DATA_DIR` doit donc être persistant dans le conteneur.

## Installation dans le conteneur existant

Sur un conteneur Debian/Ubuntu amd64 avec accès root, l’installateur vérifie les prérequis, installe Node.js 22 si nécessaire, récupère/actualise le clone Git et construit le panneau. Portwarp est le fournisseur par défaut : `pwrp` v0.3.7 est téléchargé depuis le domaine officiel et accepté uniquement si son SHA-256 correspond à la somme officielle épinglée. Playit reste une option de secours avec ses binaires officiels v1.0.10 vérifiés ; Localtonet est conservé comme alternative inactive par défaut. Aucun script Portwarp n’est exécuté à l’aveugle en root. Pour lancer l’installateur depuis GitHub :

```bash
curl -fsSL https://raw.githubusercontent.com/JCVERSA/n-craft/arena/01a0e06a-n-craft/scripts/install.sh -o /tmp/ncraft-install.sh
less /tmp/ncraft-install.sh   # inspecter avant exécution, surtout en root
bash /tmp/ncraft-install.sh
```

Par défaut, l’installateur réutilise le clone courant s’il s’agit de `JCVERSA/n-craft`, sinon `/root/n-craft` (root) ou `~/n-craft`. Pour choisir un emplacement :

```bash
bash /tmp/ncraft-install.sh --dir /opt/n-craft
```

L’installateur et `ncraft update` ciblent volontairement la branche `arena/01a0e06a-n-craft` (pas `main`, même après une longue période). Ils sont relançables : ils utilisent `git pull --ff-only` sur cette branche, refusent un dépôt sale ou un dossier non vide étranger, et ne remplacent jamais les secrets de `.env`, le catalogue de versions ni les données Bedrock. Le premier passage crée `.env` avec un `PANEL_TOKEN` aléatoire (droits `0600`) ; si un `.env` régulier existe sans jeton, seul le jeton manquant est ajouté. La migration du fournisseur ne change que l’ancien défaut `TUNNEL_PROVIDER=localtonet` en `portwarp` et conserve une marque afin qu’un choix Localtonet explicite ultérieur soit respecté. Un `.env` symbolique n’est jamais réécrit automatiquement : configure son fichier cible manuellement. Un build/dependency failure n’efface pas le monde. Le script ne démarre ni le panneau ni Bedrock automatiquement.

Pour une installation manuelle dans un clone propre :

```bash
bash scripts/install.sh --dir /chemin/vers/n-craft
# ou, dans le clone :
ncraft setup
ncraft start
```

Prérequis runtime : Linux x86_64, glibc 2.29+, `libcurl.so.4`, Node.js 20.19+ ou 22.12+ (Node 22 recommandé), et npm. L’installateur peut installer Node 22 et `libcurl4` avec apt lorsqu’il est lancé en root. Sur un conteneur non-root, installe ces dépendances au préalable. L’architecture ARM n’est pas prise en charge par le binaire Bedrock de ce projet.

La mémoire disponible inférieure à **4 Gio** est un avertissement, pas un blocage. Le panneau reste essayable, mais le build, le client de tunnel et Bedrock partagent la mémoire du conteneur ; une terminaison OOM est possible. Vérifie également l’espace libre avant un Deploy.

## Gestionnaire `ncraft`

L’installateur crée un lien `ncraft` vers `manage.sh` (`/usr/local/bin` pour root ou `~/.local/bin` pour un utilisateur standard). Commandes disponibles :

```text
ncraft setup       npm ci + build, crée .env seulement si nécessaire
ncraft start       démarre le panneau en arrière-plan dans le conteneur
ncraft stop        arrête gracieusement le panneau et ses processus enfants
ncraft restart     redémarre le panneau
ncraft status      état du panneau, health HTTP, mémoire et variables masquées
ncraft logs        suit les journaux du panneau
ncraft update      met à jour arena/01a0e06a-n-craft, npm ci et build sans Deploy
ncraft doctor      diagnostic Node, tunnel sélectionné, build, .env, libcurl et mémoire
ncraft env         menu interactif .env ; les secrets sont masqués
ncraft env list    affiche la configuration sans révéler les secrets
ncraft env get CLE lit une valeur ; --reveal est nécessaire pour un secret
ncraft env set CLE VALEUR
ncraft env set PANEL_TOKEN  saisie masquée interactive, sans valeur dans l’historique
ncraft env unset CLE
ncraft env edit    ouvre .env dans $EDITOR (ou vi)
```

`ncraft start` ne lance que le dashboard : Bedrock se démarre avec **Start** dans le dashboard. Le panneau est un processus enfant du processus Node : fermer l’onglet ne l’arrête pas ; arrêter le conteneur arrête le panneau et ses enfants. Bedrock n’est pas relancé automatiquement après redémarrage du conteneur : ouvre le dashboard et utilise Start.

Le token du panneau n’est jamais imprimé par `setup`, `status`, `doctor` ou `env list`. Pour le consulter localement sur le conteneur :

```bash
ncraft env get PANEL_TOKEN --reveal
```

Ne publie pas cette sortie et ne la partage pas dans un chat. `ncraft env set` met à jour une valeur sans remplacer les autres lignes ; un ancien `PLAYIT_SECRET_KEY` peut être retiré avec `ncraft env unset PLAYIT_SECRET_KEY`.

## Configuration réseau, HTTPS et tunnels

Le panneau écoute sur `0.0.0.0:${PORT}` (`3000` par défaut). En production, publie-le derrière une terminaison TLS : les routes interactives refusent HTTP et les cookies de session sont `Secure`. Si le panneau est derrière un reverse proxy, configure `PANEL_TRUST_PROXY` uniquement pour les proxies réellement de confiance ; configure `PANEL_ORIGIN` lorsque l’origine publique exacte ne peut pas être déduite. Le frontend et l’API utilisent la même origine.

### Portwarp (fournisseur par défaut)

À l’installation, N-Craft installe `pwrp` depuis `https://portwarp.com/download/` et compare l’archive Linux amd64 à son SHA-256 officiel épinglé avant extraction et installation. Il n’exécute pas de `curl | bash` en root. Si un CLI fonctionnel existe déjà, il est conservé ; les identifiants restent dans le profil Portwarp privé de l’utilisateur Linux qui exécute le panneau (`~/.portwarp`), jamais dans `.env`, Git, les logs ou `data/state.json`.

Au démarrage/redémarrage du panneau, N-Craft vérifie l’authentification du CLI. Si le conteneur n’est pas lié, il lance `pwrp login` et affiche dans la section tunnel du dashboard le lien officiel et le code d’appareil temporaire. Termine toi-même l’approbation depuis ta session Portwarp authentifiée. Le code n’existe qu’en mémoire du runner et dans la réponse protégée du dashboard ; il est effacé dès la fin du flux. Il ne faut pas le copier dans le chat ni dans `.env`.

Le tunnel doit déjà exister dans ton compte et porter le nom exact `Minecraft Bedrock` (modifiable avec `PORTWARP_TUNNEL_NAME`). S’il manque ou est désactivé, crée/active-le **manuellement** dans [Portwarp Tunnels](https://portwarp.com/tunnels) : type UDP, cible locale `127.0.0.1:19132`. N-Craft n’en crée, ne modifie ni n’efface aucun. Après sa création, le panneau le détecte et lance `pwrp connect "Minecraft Bedrock" --save --detach`; la sélection est enregistrée par le CLI et N-Craft la vérifie/reconnecte à chaque démarrage/redémarrage du panneau. Stop/Start de Bedrock, Deploy et l’arrêt gracieux du panneau ne lancent jamais `pwrp stop` et ne coupent pas le tunnel. En revanche, N-Craft ne configure pas un démarrage automatique du conteneur après un reboot complet de l’hôte.

Le dashboard affiche l’adresse publique et le statut de session du relais. Cela **ne prouve pas** que Bedrock UDP est joignable : le contrôle local de Portwarp est TCP, alors que Bedrock utilise UDP. Valide la connexion depuis un client Bedrock. Le forfait Free de Portwarp annonce actuellement un tunnel actif et UDP sans SLA ; ses conditions, disponibilité et limites peuvent changer, donc aucune durée d’uptime n’est garantie.

### Localtonet (alternative inactive par défaut)

Le code Localtonet est conservé, mais le fournisseur par défaut est désormais Portwarp. Pour activer volontairement Localtonet, choisis `TUNNEL_PROVIDER=localtonet` dans `.env` puis redémarre le panneau. N-Craft ne télécharge pas et ne remplace pas son binaire : installe le client Linux officiel depuis la [documentation Linux](https://localtonet.com/documents/linux) ou la [page de téléchargement](https://localtonet.com/download), puis vérifie sa présence avec `ncraft doctor`. Le runner utilise `--headless --authtoken-file <fichier>`.

Configure `LOCALTONET_AUTH_TOKEN` et `LOCALTONET_API_KEY` depuis `ncraft env` si tu actives ce fallback. La saisie est masquée ; les secrets Localtonet ne sont pas renvoyés au navigateur, inscrits dans les logs applicatifs ni persistés dans `data/state.json`. Le tunnel UDP `19132` reste à créer manuellement. Le statut d’API n’affirme pas que le tunnel est joignable depuis Internet.

### Playit (option de secours)

Portwarp est utilisé par défaut. Pour sélectionner Playit, change `TUNNEL_PROVIDER=playit` dans `.env`, puis redémarre le panneau. L’installateur fournit les binaires Playit officiels v1.0.10 vérifiés par SHA-256 ; un binaire préexistant n’est pas remplacé automatiquement.

Avec Playit sélectionné, le dashboard lance le CLI officiel `playit` (`PLAYIT_CLI_BIN`) pour générer un lien de claim ; le daemon configuré dans `PLAYIT_BIN` est attaché/démarré sans lancer un second daemon à l’aveugle. Le parcours est :

1. ouvrir le lien de claim et approuver l’agent sur le site Playit ;
2. créer/configurer manuellement un tunnel **Minecraft Bedrock / UDP / port local 19132** dans Playit ;
3. attendre que l’adresse publique soit détectée et affichée dans le dashboard.

Aucune valeur `PLAYIT_SECRET_KEY` n’est requise dans `.env` pour ce parcours. Le daemon stocke le secret dans un fichier local privé ; il n’est pas exposé à l’API ni enregistré dans l’état JSON. Si le claim ou le tunnel n’est pas prêt, le dashboard permet par défaut de démarrer Bedrock avec un avertissement. La disponibilité réelle dépend du binaire installé, de l’approbation du claim et de la configuration manuelle du tunnel ; valide chaque étape dans ton environnement. Un ancien agent/CLI incompatible (par exemple Playit 0.17.x) doit être remplacé ou configuré manuellement en v1.x compatible IPC v2. Le test local simule le protocole IPC et ne prouve pas l’accès au service Playit réel.

## Deploy non destructif, Start/Stop et données

- **Deploy** télécharge et extrait d’abord le ZIP dans un dossier temporaire, pendant que la version actuelle continue de fonctionner. Lorsque la nouvelle version est prête, le panneau arrête Bedrock gracieusement, met à jour les fichiers du serveur et le redémarre automatiquement. Il ne supprime jamais `BEDROCK_SERVER_DIR`.
- Lors d’une mise à jour, le monde (`worlds`), les sauvegardes, packs, structures et configurations (`server.properties`, `permissions.json`, allowlist et fichiers du dossier `config`) déjà présents sont conservés. Les fichiers inconnus qui ne figurent pas dans la nouvelle archive ne sont pas supprimés. Seule la version sélectionnée est modifiable depuis le formulaire pendant une mise à jour ; les champs de réglage sont verrouillés pour éviter une modification involontaire. Lors d’une première installation, le formulaire initialise la configuration.
- Si le précontrôle, le téléchargement ou l’extraction échoue, le serveur existant reste en ligne. Si une erreur intervient pendant la copie des nouveaux fichiers, le monde et les configurations restent sur disque ; le serveur est signalé en échec/arrêté afin que l’opérateur puisse relancer Deploy.
- **Start** démarre le binaire installé sans effacer ni réécrire le monde. **Stop** demande un arrêt gracieux au serveur. Ces opérations ne démarrent, n’arrêtent ni ne suppriment le tunnel Portwarp, Localtonet ou Playit.
- Le dashboard affiche le nombre de joueurs à partir des événements de connexion/déconnexion Bedrock, l’uptime depuis le dernier démarrage et l’usage CPU/RAM du processus Bedrock dans le conteneur. L’usage CPU/RAM est mesuré pour le processus enfant, pas pour le panneau ni l’hôte.
- Par défaut, Bedrock annonce le compte à rebours de **03:55 à 04:00**, puis redémarre quotidiennement à **04:00 Africa/Douala**. Les annonces sont répétées chaque minute ; l’arrêt gracieux et le redémarrage ont lieu même si des joueurs sont connectés. Heure, fuseau, durée et activation sont configurables avec `BDS_RESTART_TIME`, `BDS_RESTART_TIMEZONE`, `BDS_RESTART_WARNING_MINUTES` et `BDS_RESTART_ENABLED` dans `.env` (redémarre le panneau après modification). À l’arrêt/redémarrage du conteneur, Bedrock lui-même reste arrêté jusqu’à Start ; l’horaire redémarre uniquement une instance déjà en ligne.
- Le panneau verrouille à la première installation `server-port=19132`, `server-portv6=19133`, `online-mode=false` et `allow-list=false`. Sur les mises à jour, les fichiers de configuration et permissions existants sont préservés tels quels.

| Chemin | Rôle / durée de vie |
|---|---|
| `.env` | Secrets et configuration ; conservé par l’installateur, mode `0600` pour un fichier régulier. |
| `data/state.json` | État du panneau, pipeline, serveur et tunnel sélectionné (adresse/statut uniquement) ; aucun code Portwarp, secret Localtonet ou clé Playit. |
| `~/.portwarp/` | Profil CLI Portwarp privé de l’utilisateur Linux courant ; géré uniquement par `pwrp`, jamais copié dans `.env` ni déplacé par N-Craft. |
| `data/server.log` | Journal Bedrock tournant, limité à 10 Mio avec copie `.1`. |
| `data/panel.log`, `data/panel.pid` | Journal et PID du gestionnaire `ncraft`. |
| `data/playit/` | Fichier secret privé par défaut de l’agent ; une configuration Playit déjà existante dans `~/.local/share/playit/secret.toml` peut aussi être réutilisée. |
| `data/versions.json` | Catalogue édité manuellement ; il n’est jamais remplacé par `.env` ou une opération Deploy. |
| `bedrock/server/` | Dossier persistant du binaire, monde, packs et configurations Bedrock ; Deploy le met à jour sans l’effacer. |

Monte `DATA_DIR` et, si nécessaire, `BEDROCK_SERVER_DIR` en volumes persistants selon l’environnement d’hébergement. Un arrêt forcé du conteneur peut encore interrompre une sauvegarde en cours ; laisse l’arrêt gracieux se terminer.

## Développement, build et tests

```bash
npm ci
npm run lint
npm test
npm run build
npm start
```

`data/versions.json` est un catalogue édité manuellement. Chaque entrée doit pointer vers un ZIP Linux officiel Bedrock via HTTPS. Le catalogue initial contient la version `1.19.50.02` et l’URL fournie pour le test ; sa disponibilité réelle n’a pas été vérifiée ici. Au Deploy, le backend exige une réponse HTTP réussie, une taille non nulle, une signature ZIP et une extraction sûre. Une URL indisponible fait échouer le pipeline sans démarrer un serveur partiel.

Les tests automatiques couvrent le démarrage non destructif, les runners Portwarp/Localtonet/Playit simulés, la migration .env, la sécurité et les cas de déploiement ; ils ne remplacent pas un essai avec les vrais clients Portwarp/Localtonet/Playit, un compte réel et un vrai binaire Bedrock.
