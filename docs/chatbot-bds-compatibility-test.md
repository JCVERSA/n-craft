# Test guidé du chatbot contre le vrai BDS

Ce test vérifie qu’un **binaire officiel Bedrock Dedicated Server** accepte une connexion RakNet et relaie un message de chat. Il ne remplace pas la validation de toutes les familles de protocole et ne valide ni Microsoft, ni les clés IA.

## Sécurité et limites

- Utilise uniquement une **copie temporaire, vide et jetable** du BDS téléchargée depuis le site HTTPS officiel Minecraft. N’utilise pas le dossier Bedrock actif, ses mondes, ni ses paramètres réels.
- Le test met `online-mode=false` dans cette copie uniquement afin que deux clients de test hors ligne puissent se connecter. Cette option ne doit jamais être appliquée à un serveur public ou à ton serveur réel.
- N’ajoute pas de transfert UDP et ne crée pas de tunnel pour le port de test. N’effectue pas ce test sur une machine accessible publiquement. Si tu ne peux pas garantir que le port reste privé, arrête-toi.
- Le script se connecte seulement à `127.0.0.1`. Il n’ouvre pas de port, ne démarre ni n’arrête BDS, ne lit pas `.env`, ne lie aucun compte Microsoft et n’appelle aucun fournisseur IA.
- N’accepte l’EULA que si tu l’as lue et que tu l’acceptes.

## Procédure

1. Choisis une build BDS stable exacte du catalogue N-Craft, par exemple `1.19.50.02`, `1.20.81.01` ou `1.21.131.1`.
2. Télécharge son archive Linux depuis le lien `https://www.minecraft.net/bedrockdedicatedserver/bin-linux/bedrock-server-<version>.zip` indiqué dans `data/versions.json`. Si le navigateur affiche un avertissement HTTPS, ne le contourne pas et n’utilise pas de miroir.
3. Extrais l’archive dans un **nouveau dossier temporaire** qui ne contient aucun monde réel. Dans `server.properties` de cette copie seulement, définis un port UDP libre, `max-players=2`, `allow-list=false` et `online-mode=false`. Ne crée pas de tunnel ni de règle de port-forwarding.
4. Lance le BDS depuis ce dossier en suivant le guide inclus dans l’archive. Si l’EULA est présentée, accepte-la seulement après l’avoir lue. Laisse le serveur de test ouvert.
5. Depuis la racine de N-Craft, dans un second terminal, lance la commande correspondant à la build et au port choisi :

   ```sh
   npm run chatbot:probe -- --version 1.19.50.02 --port 29132
   ```

   Remplace la version et le port par ceux de ton instance temporaire. À la demande, tape exactement `TEST-BDS`.

6. Le probe démarre deux clients temporaires sans compte et envoie un message aléatoire ordinaire (sans le préfixe `..`). `PASS` signifie que le BDS a relayé ce message au second client. Arrête ensuite le serveur de test avec `Ctrl+C` et supprime son dossier temporaire.
7. Répète le test avec une seule build à la fois. Pour les premiers repères, utilise `1.19.50.02`, `1.20.81.01` et `1.21.131.1`. Les versions `1.20.81` et `1.21.131` utilisent pour le probe le schéma client compatible `1.20.80` (protocole 671) et `1.21.130` (protocole 898), respectivement. Le probe signale cet alias; l’essai réel reste obligatoire.

Un résultat `PASS` valide seulement la build et le protocole effectivement essayés. N-Craft n’activera pas automatiquement les autres versions de la plage avant que leurs familles de protocole aient été vérifiées. Pour nous communiquer le résultat, partage uniquement la ligne `PASS` ou le message d’erreur; aucun identifiant ni fichier de monde n’est nécessaire.
