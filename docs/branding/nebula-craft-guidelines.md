# Nebula Craft — guide de marque

**Édition 1.0 · 2 octobre 2026**

**Direction retenue : B — « Monde ouvert »**

## Idée

Une arche volontairement ouverte et trois blocs en chemin forment un seuil accueillant vers un monde construit ensemble. La géométrie évoque la construction par blocs sans reprendre un portail, un personnage ou un logo de jeu existant. Le nom **Nebula Craft** est conservé à l’identique.

## Système de logo

| Variante | Fichier maître | Usage |
| --- | --- | --- |
| Symbole couleur | `public/assets/nebula-craft-mark.svg` | Emblème seul sur une surface sombre. |
| Lockup horizontal couleur | `public/assets/nebula-craft-lockup-horizontal.svg` | En-tête, interface, site et documentation sur fond sombre. |
| Lockup empilé couleur | `public/assets/nebula-craft-lockup-stacked.svg` | Composition carrée ou espace vertical, sur fond sombre. |
| Versions monochromes | Fichiers `*-black.svg` / `*-white.svg` | Noir sur fond clair; ivoire sur fond sombre. À préférer au logo couleur sur fond clair. |
| Accents unis | `nebula-craft-mark-mono-moss.svg`, `nebula-craft-mark-mono-magma.svg` | Variantes colorées unies pour un fond sombre; jamais sur blanc. |
| Symbole carré sans tuile | `public/assets/nebula-craft-mark-square.svg` | Avatar sur fond sombre; sur fond clair, employer la variante monochrome noire. |
| Icône d’application | `public/assets/nebula-craft-app-icon.svg` | Tuile charbon carrée, sans coins pré-arrondis; laisser l’appareil appliquer son masque. |
| Icône Apple touch | `public/apple-touch-icon.png` | PNG 180 × 180 à fond carré, adapté au masque iOS. |
| Favicons | `public/favicon.svg`, `public/favicon.ico`, PNG 16/32/48 px | Onglet et favoris; les maîtres nommés sont aussi dans `public/assets/`. |

Les SVG sont les maîtres vectoriels. Les exports PNG du symbole sont disponibles en 512 et 1024 px; les lockups horizontaux en 1560 px de large; les lockups empilés en 1024 px de large; l’icône d’application en 180, 192 et 512 px. Les exports PNG des lockups existent en couleur, noir et ivoire.

## Palette

| Nom | HEX | RGB | Valeur indicative CMJN* |
| --- | --- | --- | --- |
| Mousse | `#9BE6B0` | 155, 230, 176 | 33, 0, 23, 10 |
| Magma | `#FFB875` | 255, 184, 117 | 0, 28, 54, 0 |
| Charbon | `#141216` | 20, 18, 22 | 9, 17, 0, 91 |
| Ivoire | `#F0EAF2` | 240, 234, 242 | 1, 3, 0, 5 |

Les deux accents reprennent la palette de l’interface Nebula Craft. Sur le charbon, le contraste mesuré est de **12,71:1** pour Mousse et **10,96:1** pour Magma. Les accents seuls sont trop peu contrastés sur blanc; sur fond clair, employer le lockup noir ou le symbole noir. La palette CMJN est une conversion mathématique approximative, pas une épreuve imprimée.

**Règle simple :** couleur sur sombre; monochrome sur clair. L’icône d’application conserve son fond charbon intégré.

## Typographie

Le mot-symbole est tracé à partir de **Space Grotesk Bold 700**. Les lettres sont converties en tracés dans les SVG : aucune police externe n’est requise pour afficher le logo. Space Grotesk est également déjà chargée pour l’interface; elle est distribuée sous licence SIL Open Font License 1.1 ([projet et licence](https://github.com/google/fonts/tree/main/ofl/spacegrotesk)). Pour les textes d’interface, conserver la typographie déjà présente dans l’application; ne pas reconstituer le mot-symbole avec une police substitutive.

## Tailles et espace de protection

- Le symbole a été rendu et vérifié à **16, 24, 32, 48, 64, 256 et 512 px**. Le favicon dédié, sur tuile sombre, a été vérifié à 16 px.
- Pour le symbole seul, viser au moins **16 px** à l’écran; l’icône couleur fonctionne au mieux à partir de 24 px. Pour une version monochrome, préserver une épaisseur visuelle d’au moins 1,5 px.
- Pour les lockups complets, viser au moins **180 px de largeur** à l’écran et **35 mm** en impression. En dessous, utiliser le symbole seul.
- Garder autour du logo une marge libre au moins égale à **30 unités du dessin** (la largeur d’un petit bloc dans le viewBox 256 × 256). Aucun texte, bord, photo ni contrôle ne doit entrer dans cette zone.

## À faire / à éviter

- Utiliser les SVG maîtres et conserver proportions, espacements et ordre des couleurs.
- Employer le lockup horizontal quand la largeur le permet; choisir l’empilé uniquement pour un format étroit.
- Sur une surface claire, choisir explicitement les versions `black`; sur une surface sombre, utiliser les versions couleur ou `white`.
- Ne pas étirer, incliner, recadrer, retourner, animer ou redessiner le symbole. Ne pas ajouter contour, dégradé, lueur ou ombre au dessin.
- Ne pas placer la version couleur sur blanc ou sur une image chargée; ne pas improviser une nouvelle combinaison de couleurs.
- Ne pas associer le logo à des textures, personnages ou symboles Minecraft/Mojang qui le feraient passer pour un logo officiel ou affilié.

## Intégration web

`index.html` référence le favicon SVG, les PNG 16/32/48 px, le fichier ICO et l’icône Apple touch. `NebulaBrandMark` utilise le symbole couleur sur le fond charbon de l’interface. Les icônes fonctionnelles de l’application restent inchangées.

## Décision d’intégration — Design Mode v2.3

- **Produit et surface :** panneau privé d’exploitation Minecraft Bedrock; l’interface principale est une surface **OPERATE**, utilisée pour surveiller et piloter un serveur.
- **Objectif :** rendre la marque reconnaissable entre l’onglet, l’accès opérateur, l’en-tête et la fenêtre « À propos », sans déguiser les signaux opérationnels en décoration.
- **Principe :** garder l’identité de marque distincte du design system existant. La palette, la typographie, les contrôles et les états de service de l’application restent en place; les icônes fonctionnelles et la politique d’accès ne changent pas.
- **Périmètre touché :** masters et favicons; `NebulaBrandMark`; wordmark de connexion et d’en-tête; titre de la fenêtre « À propos » et libellés de marque dans les dialogues.
- **Accessibilité et langue :** le symbole est décoratif lorsque le nom adjacent identifie déjà le produit; le contraste des accents sur charbon est documenté plus haut. `Nebula Craft` est marqué `translate="no"` sur ses libellés de marque afin de préserver le nom; le bouton « À propos » garde son libellé visible comme nom accessible, sans redondance.
- **Responsive et performance :** le format carré existant s’adapte aux emplacements prévus; aucun nouveau breakpoint, script, chargement de police ou dépendance n’est ajouté. Le mot-symbole reste vectoriel et ne charge pas Space Grotesk séparément.
- **Risque de régression :** faible; la surface modifiée est limitée à l’identité et à ses libellés, sans effet attendu sur les commandes serveur, les données ou les autorisations. Ne pas réutiliser les accents de marque pour changer la signification des états.

**DESIGN STATUS: IMPLEMENTED — NOT FULLY VERIFIED.** Le kit et son intégration source ont été soumis aux tests, au lint et au build; les exports d’icône et le rendu du symbole à plusieurs tailles sont documentés ci-dessus. Une inspection navigateur réelle des écrans, aux formats mobile et bureau, n’a pas été réalisée : ne pas traiter cette note comme une validation visuelle complète du produit.

Voir la planche [`nebula-craft-brand-board.png`](nebula-craft-brand-board.png) et sa version vectorielle [`nebula-craft-brand-board.svg`](nebula-craft-brand-board.svg). Les mises en situation dans `nebula-craft-identity.html` illustrent des supports de marque et ne décrivent pas de nouvelles fonctions. La provenance des assets est consignée dans [`../../ASSET-CREDITS.md`](../../ASSET-CREDITS.md).

*Les conversions CMJN sont indicatives; faire valider une épreuve par l’imprimeur avant toute production physique.*
