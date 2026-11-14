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
