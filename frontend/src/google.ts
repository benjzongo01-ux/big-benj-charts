// Connexion « Continuer avec Google » (Firebase Authentication).
// La bibliothèque Firebase n'est téléchargée que sur la version en ligne : en local, rien n'est chargé.
import type { Auth } from 'firebase/auth'
import { setRefresher, setToken } from './api'

export interface FirebaseWebConfig {
  apiKey: string
  authDomain: string
  projectId: string
}

let auth: Auth | null = null

/** Prépare Firebase et indique si une session Google est déjà ouverte. */
export async function initGoogle(config: FirebaseWebConfig): Promise<boolean> {
  const [{ initializeApp }, m] = await Promise.all([import('firebase/app'), import('firebase/auth')])
  auth = m.getAuth(initializeApp(config))
  auth.languageCode = 'fr'
  // Le jeton de session dure une heure : Firebase le renouvelle, on garde toujours le dernier.
  m.onIdTokenChanged(auth, (user) => {
    if (user) void user.getIdToken().then(setToken)
    else setToken('')
  })
  setRefresher(async () => (auth?.currentUser ? auth.currentUser.getIdToken(true) : ''))
  window.setInterval(() => void auth?.currentUser?.getIdToken(true).then(setToken), 40 * 60 * 1000)
  await auth.authStateReady()
  if (!auth.currentUser) {
    setToken('')
    return false
  }
  setToken(await auth.currentUser.getIdToken())
  return true
}

/** Ouvre la fenêtre Google. Le compte est créé automatiquement à la première connexion. */
export async function signInGoogle(): Promise<void> {
  if (!auth) throw new Error('Connexion Google indisponible.')
  const m = await import('firebase/auth')
  const provider = new m.GoogleAuthProvider()
  provider.setCustomParameters({ prompt: 'select_account' })
  try {
    const result = await m.signInWithPopup(auth, provider)
    setToken(await result.user.getIdToken())
  } catch (e) {
    const code = (e as { code?: string }).code ?? ''
    if (code.includes('popup-closed') || code.includes('cancelled-popup')) throw new Error('Connexion annulée.')
    if (code.includes('popup-blocked')) throw new Error('Ton navigateur a bloqué la fenêtre Google. Autorise les fenêtres pop-up pour ce site.')
    if (code.includes('unauthorized-domain')) throw new Error('Ce domaine n’est pas autorisé dans Firebase (Authentication > Paramètres > Domaines autorisés).')
    throw new Error('Connexion Google impossible. Réessaie dans un instant.')
  }
}

export async function signOutGoogle(): Promise<void> {
  if (auth) await (await import('firebase/auth')).signOut(auth)
  setToken('')
}

export const googleEmail = (): string => auth?.currentUser?.email ?? ''
