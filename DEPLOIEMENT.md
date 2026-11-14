# Mettre Big Benj Charts en ligne, gratuitement

Trois services gratuits, chacun avec son rôle :

| Service | Rôle | Limite de l'offre gratuite |
| --- | --- | --- |
| GitHub | Garde le code et déclenche les mises à jour | Aucune pour un dépôt privé |
| Firebase | « Continuer avec Google » et données de chaque utilisateur (dessins, stratégies, journal, réglages) | 1 Go, 50 000 lectures et 20 000 écritures par jour |
| Render | Fait tourner le serveur et affiche le site | Se met en veille après 15 minutes sans visite (environ 1 minute pour se réveiller), 750 heures par mois |

Compte environ 30 minutes. Tu fais les étapes 1 à 5 une seule fois.

## 1. Envoyer le code sur GitHub

1. Crée un compte sur https://github.com puis un dépôt **privé** nommé `big-benj-charts` (sans README).
2. Dans le dossier du projet, lance (remplace `TON-NOM`) :

```
git remote add origin https://github.com/TON-NOM/big-benj-charts.git
git push -u origin master
```

Une fenêtre GitHub s'ouvre pour te connecter la première fois.

## 2. Créer le projet Firebase

1. Va sur https://console.firebase.google.com et clique sur **Ajouter un projet**. Google Analytics n'est pas nécessaire.
2. **Authentication** > **Commencer** > onglet **Mode de connexion** > **Google** > **Activer**, choisis ton e-mail d'assistance, **Enregistrer**.
3. **Firestore Database** > **Créer une base de données** > emplacement en Europe (`eur3`) > **mode production**.
   Le mode production bloque tout accès direct depuis un navigateur : seul ton serveur lit et écrit. Ne change pas ces règles.

## 3. Récupérer les deux clés Firebase

1. **Clé web (publique)** : roue dentée > **Paramètres du projet** > **Général** > **Vos applications** > icône Web `</>` >
   donne un nom > **Enregistrer l'application**. Copie la valeur de `apiKey`.
2. **Clé du compte de service (secrète)** : **Paramètres du projet** > **Comptes de service** >
   **Générer une nouvelle clé privée**. Un fichier `.json` se télécharge.

Ce fichier donne un accès complet à ta base. Ne le mets jamais dans Git, ne l'envoie à personne.

## 4. Lancer le serveur sur Render

1. Crée un compte sur https://render.com en te connectant avec GitHub.
2. **New** > **Blueprint** > choisis le dépôt `big-benj-charts`. Render lit le fichier `render.yaml`.
3. Render demande deux valeurs :
   - `FIREBASE_API_KEY` : la valeur `apiKey` de l'étape 3.
   - `FIREBASE_SERVICE_ACCOUNT` : ouvre le fichier `.json` avec le Bloc-notes et colle **tout son contenu**.
4. **Apply**. La première construction prend environ 5 minutes.
5. Note l'adresse du site, du type `https://big-benj-charts.onrender.com`.

## 5. Autoriser ton site dans Firebase

Dans Firebase : **Authentication** > **Paramètres** > **Domaines autorisés** > **Ajouter un domaine**,
et colle l'adresse Render sans `https://` (par exemple `big-benj-charts.onrender.com`).

Ouvre ensuite ton site : le bouton **Continuer avec Google** crée le compte à la première connexion.

## Recevoir les alertes sur le téléphone

1. Sur le téléphone, ouvre le site dans **Chrome** et connecte-toi avec le **même compte Google** que sur l'ordinateur.
2. Menu de Chrome (les trois points) > **Installer l'application** (ou **Ajouter à l'écran d'accueil**).
   L'icône Big Benj Charts apparaît avec les autres applications.
3. Ouvre l'application, puis l'icône réveil de la colonne de droite > **Activer la sonnerie sur cet appareil**,
   et accepte les notifications.
4. Appuie sur **Tester la sonnerie**, puis quitte l'application : la notification d'essai doit arriver.

Les alertes posées sur l'ordinateur apparaissent sur le téléphone, et inversement. Quand un prix est atteint,
le serveur envoie une notification à tous les appareils du compte, même application fermée.

À savoir :

- Le son est celui des notifications du téléphone. Pour qu'il sonne fort : Paramètres Android > Applications >
  Big Benj Charts > Notifications, et choisis un son et une importance élevée. Désactive aussi l'économie de
  batterie pour Chrome, sinon Android peut retarder les notifications.
- Sur iPhone, il faut d'abord ajouter le site à l'écran d'accueil depuis Safari (menu Partager).
- Le serveur vérifie les prix toutes les 10 secondes. Un pic très bref entre deux vérifications peut être manqué.
- Tant qu'il reste des alertes actives, le serveur se maintient éveillé. Sans alerte active, il s'endort comme avant.

## Application Android (APK)

Le dossier `android/` contient une vraie application Android qui affiche le site en plein écran et reçoit ses notifications.

- **Installer sur un téléphone branché en USB** (débogage USB activé) :
  `adb install -r android/app/build/outputs/apk/release/app-release.apk`
- **Installer sur un autre téléphone** : ouvrir `https://big-benj-charts.onrender.com/big-benj-charts.apk` dans Chrome,
  puis accepter l'installation depuis une source inconnue.
- **Reconstruire l'APK** : dans `android/`, lancer Gradle avec la tâche `assembleRelease`.

La clé de signature est dans `android/bigbenj-release.jks` et son mot de passe dans `android/keystore.properties`.
Ces deux fichiers ne sont pas dans Git : **fais-en une copie de sauvegarde**. Sans eux, impossible de publier une
mise à jour de l'application ; il faudrait la désinstaller et la réinstaller sur chaque téléphone.

L'application n'a presque jamais besoin d'être reconstruite : elle affiche le site, donc chaque mise à jour du site
arrive toute seule dedans.

Sur **iPhone**, il n'existe pas de fichier à installer : Apple n'accepte que les applications publiées sur l'App Store
(compte développeur à 99 $ par an et un Mac pour la construire). L'installation se fait depuis Safari :
menu Partager > « Sur l'écran d'accueil ». L'icône, le plein écran et les notifications fonctionnent ainsi (iOS 16.4 ou plus).

## Mettre à jour le site

Chaque envoi sur GitHub redéploie le site tout seul :

```
git add -A
git commit -m "Ce que j'ai changé"
git push
```

Pour avancer sans risque : travaille sur une branche `dev`, teste en local avec `lancer.bat`,
puis fusionne dans `master` seulement ce qui fonctionne.

## Ce qui diffère de la version locale

- **Connexion obligatoire** avec Google. Chaque utilisateur ne voit que ses propres données.
- **Stratégies Python personnalisées désactivées** : exécuter le code d'inconnus sur ton serveur serait dangereux.
  Les 6 stratégies intégrées restent disponibles.
- **MetaTrader 5 indisponible** : il exige Windows et un terminal ouvert.
- **Bougies en cache effacées** à chaque redémarrage du serveur : elles se retéléchargent à la demande.
  Les données des utilisateurs, elles, sont dans Firebase et ne sont jamais perdues.
- **Réveil lent** : après 15 minutes sans visite, la première page met environ une minute à s'afficher.

## En cas de problème

| Symptôme | Cause probable |
| --- | --- |
| Le déploiement échoue avec « Firebase n'est pas configuré » | Une des deux clés manque dans Render (Environment) |
| « Ce domaine n'est pas autorisé » au clic sur Google | L'étape 5 n'est pas faite, ou l'adresse est mal recopiée |
| La fenêtre Google ne s'ouvre pas | Le navigateur bloque les fenêtres pop-up pour ce site |
| Erreur 401 après connexion | La clé de compte de service vient d'un autre projet Firebase que la clé web |
| Pas de données crypto | Le serveur n'est pas en Europe : garde `region: frankfurt` dans `render.yaml` |

## Avant d'ouvrir à beaucoup de monde

- Vérifie les conditions d'utilisation de Yahoo Finance et de Dukascopy : la rediffusion de leurs données à des tiers
  n'est pas forcément autorisée. Binance fournit ses données publiques sans clé.
- L'offre gratuite de Render suffit pour toi et quelques testeurs. Avec un public régulier, passe à une offre
  payante (environ 7 $ par mois) pour supprimer la mise en veille.
