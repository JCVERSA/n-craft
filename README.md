# Nebula Craft — panel Bedrock mono-instance

Panneau privé pour **une seule instance Bedrock Dedicated Server** dans le conteneur Linux déjà fourni. L’installation et l’exécution ne lancent pas Docker, n’ajoutent pas de Dockerfile et n’utilisent pas de base de données. Les réglages, l’état, les journaux et les fichiers Playit sont gardés dans des fichiers locaux ; le dossier `DATA_DIR` doit donc être persistant dans le conteneur.

## Installation dans le conteneur existant

Sur un conteneur Debian/Ubuntu amd64 avec accès root, l’installateur vérifie les prérequis, installe Node.js 22 si nécessaire, récupère/actualise le clone Git et construit le panneau. Il met à disposition les binaires Playit officiels v1.0.10 vérifiés par SHA-256 ; tout binaire préexistant est conservé et jamais écrasé. Pour lancer l’installateur depuis GitHub :

```bash
curl -fsSL https://raw.githubusercontent.com/JCVERSA/n-craft/arena/01a0e06a-n-craft/scripts/install.sh | bash
```

Par défaut, l’installateur réutilise le clone courant s’il s’agit de `JCVERSA/n-craft`, sinon `/root/n-craft` (root) ou `~/n-craft`. Pour choisir un emplacement :

```bash
curl -fsSL https://raw.githubusercontent.com/JCVERSA/n-craft/arena/01a0e06a-n-craft/scripts/install.sh | bash -s -- --dir /opt/n-craft
```

L’installateur et `ncraft update` ciblent volontairement la branche `arena/01a0e06a-n-craft` (pas `main`, même après une longue période). Ils sont relançables : ils utilisent `git pull --ff-only` sur cette branche, refusent un dépôt sale ou un dossier non vide étranger, et ne remplace jamais `.env`, le catalogue de versions ni les données Bedrock. Le premier passage crée `.env` avec un `PANEL_TOKEN` aléatoire (droits `0600`) ; si un `.env` régulier existe sans jeton, seul le jeton manquant est ajouté et les valeurs existantes restent intactes. Un `.env` symbolique n’est jamais réécrit automatiquement : configure son fichier cible manuellement. Un build/dependency failure n’efface pas le monde. Le script ne démarre ni le panneau ni Bedrock automatiquement.

Pour une installation manuelle dans un clone propre :

```bash
bash scripts/install.sh --dir /chemin/vers/n-craft
# ou, dans le clone :
ncraft setup
ncraft start
```

Prérequis runtime : Linux x86_64, glibc 2.29+, `libcurl.so.4`, Node.js 20.19+ ou 22.12+ (Node 22 recommandé), et npm. L’installateur peut installer Node 22 et `libcurl4` avec apt lorsqu’il est lancé en root. Sur un conteneur non-root, installe ces dépendances au préalable. L’architecture ARM n’est pas prise en charge par le binaire Bedrock de ce projet.

La mémoire disponible inférieure à **4 Gio** est un avertissement, pas un blocage. Le panneau reste essayable, mais le build, Playit et Bedrock partagent la mémoire du conteneur ; une terminaison OOM est possible. Vérifie également l’espace libre avant un Deploy.

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
ncraft doctor      diagnostic Node, Playit, build, .env, libcurl et mémoire
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

## Configuration réseau, HTTPS et Playit

Le panneau écoute sur `0.0.0.0:${PORT}` (`3000` par défaut). En production, publie-le derrière une terminaison TLS : les routes interactives refusent HTTP et les cookies de session sont `Secure`. Si le panneau est derrière un reverse proxy, configure `PANEL_TRUST_PROXY` uniquement pour les proxies réellement de confiance ; configure `PANEL_ORIGIN` lorsque l’origine publique exacte ne peut pas être déduite. Le frontend et l’API utilisent la même origine.

Au démarrage du panneau, Playit s’attache à un daemon déjà actif ou lance le daemon officiel configuré dans `PLAYIT_BIN` (par défaut `playitd`) ; il ne démarre pas de second daemon à l’aveugle. Le dashboard lance séparément le CLI officiel `playit` (`PLAYIT_CLI_BIN`) pour générer un lien de claim. Le parcours est :

1. ouvrir le dashboard et choisir la configuration Playit ;
2. ouvrir le lien de claim affiché et approuver l’agent sur le site Playit ;
3. créer/configurer manuellement un tunnel **Minecraft Bedrock / UDP / port local 19132** dans Playit ;
4. attendre que l’adresse publique soit détectée et affichée dans le dashboard.

Aucune valeur `PLAYIT_SECRET_KEY` n’est requise dans `.env` pour ce parcours. Le daemon stocke le secret dans un fichier local privé ; le secret n’est pas exposé à l’API ni enregistré dans l’état JSON. Si le claim ou le tunnel n’est pas prêt, le dashboard permet par défaut de démarrer Bedrock avec un avertissement ; l’adresse publique n’est affichée qu’après détection, elle n’est jamais devinée ni codée en dur. La disponibilité réelle dépend du binaire installé, de l’approbation du claim et de la configuration du tunnel : valide chaque étape dans ton environnement.

Les binaires v1.0.10 récupérés par l’installateur sont épinglés et vérifiés par SHA-256. Les binaires déjà présents ne sont pas remplacés automatiquement ; `ncraft doctor` indique leur présence, mais un ancien agent/CLI incompatible (par exemple Playit 0.17.x) doit être remplacé ou configuré manuellement en v1.x compatible IPC v2. Le test local simule le protocole IPC et ne prouve pas l’accès au service Playit réel.

## Deploy destructif, Start non destructif et données

- **Deploy** efface puis recrée `bedrock/server`, installe la version sélectionnée et démarre le serveur. Le monde et la configuration déjà présents à cet emplacement sont donc détruits. L’interface exige une confirmation ; le backend garde un verrou anti-concurrence, vérifie les prérequis avant le wipe et ne tente pas de lancer un serveur partiellement extrait.
- **Start** démarre le binaire Bedrock déjà installé sans effacer ni modifier le monde. **Stop** demande un arrêt gracieux au serveur. L’essai automatisé vérifie que Start préserve les fichiers du monde ; le comportement exact du binaire Bedrock cible doit néanmoins être confirmé.
- Bedrock est géré comme processus enfant du panneau. Fermer le navigateur ne l’arrête pas ; l’arrêt du conteneur/panneau arrête l’enfant. À la prochaine ouverture du conteneur, Bedrock reste arrêté jusqu’à un clic Start.
- Les opérateurs proviennent de XUID numériques dans `permissions.json`. Le panneau verrouille `server-port=19132`, `server-portv6=19133`, `online-mode=false` et `allow-list=false`; l’allow-list/whitelist fournie par l’archive est retirée.

| Chemin | Rôle / durée de vie |
|---|---|
| `.env` | Secrets et configuration ; conservé par l’installateur, mode `0600` pour un fichier régulier. |
| `data/state.json` | État du panneau, pipeline, serveur et Playit ; aucun token ni secret Playit. |
| `data/server.log` | Journal Bedrock tournant, limité à 10 Mio avec copie `.1`. |
| `data/panel.log`, `data/panel.pid` | Journal et PID du gestionnaire `ncraft`. |
| `data/playit/` | Fichier secret privé par défaut de l’agent ; une configuration Playit déjà existante dans `~/.local/share/playit/secret.toml` peut aussi être réutilisée. |
| `data/versions.json` | Catalogue édité manuellement ; il n’est jamais remplacé par `.env` ou une opération Deploy. |
| `bedrock/server/` | Dossier serveur destructif de Deploy, à persister si le monde doit survivre aux recréations du conteneur. |

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

Les tests automatiques couvrent le démarrage non destructif, le flux Playit mocké, la sécurité et les cas de déploiement ; ils ne remplacent pas un essai avec un vrai binaire Bedrock et un vrai service Playit.
