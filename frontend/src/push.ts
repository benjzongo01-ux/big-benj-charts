// Application installable et notifications : le serveur envoie les alertes de prix à cet appareil,
// même application fermée (Firebase Cloud Messaging + service worker).
import { api } from './api'
import { firebaseApp, type FirebaseWebConfig } from './google'

/** local = version sans serveur de notifications ; unsupported = navigateur incompatible. */
export type PushStatus = 'local' | 'unsupported' | 'denied' | 'off' | 'on'

interface InstallPrompt extends Event { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> }

let registration: ServiceWorkerRegistration | null = null
let online = false       // le serveur sait envoyer des notifications
let supported = false    // ce navigateur sait en recevoir
let token = ''
let installPrompt: InstallPrompt | null = null
const listeners = new Set<() => void>()
const changed = (): void => listeners.forEach((fn) => fn())

export const onPushChange = (fn: () => void): (() => void) => {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

async function register(): Promise<void> {
  const m = await import('firebase/messaging')
  const app = firebaseApp()
  if (!app || !registration || !(await m.isSupported())) throw new Error('Notifications indisponibles sur ce navigateur.')
  token = await m.getToken(m.getMessaging(app), { serviceWorkerRegistration: registration })
  if (!token) throw new Error('Jeton de notification refusé par le navigateur.')
  await api('/api/push/token', 'POST', { token })
  changed()
}

/** Au démarrage : installe le service worker, écoute les alertes reçues au premier plan, réinscrit l'appareil. */
export async function initPush(config: FirebaseWebConfig | null, onAlert: (body: string, tag: string) => void): Promise<void> {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault()
    installPrompt = e as InstallPrompt
    changed()
  })
  window.addEventListener('appinstalled', () => {
    installPrompt = null
    changed()
  })
  if (!('serviceWorker' in navigator)) return
  try {
    registration = await navigator.serviceWorker.register('/sw.js')
  } catch {
    return // contexte non sécurisé ou navigation privée
  }
  navigator.serviceWorker.addEventListener('message', (e: MessageEvent<{ type?: string; body?: string; tag?: string }>) => {
    if (e.data?.type === 'bbc-alert') onAlert(e.data.body ?? '', e.data.tag ?? '')
  })
  online = !!config?.messagingSenderId
  supported = 'PushManager' in window && 'Notification' in window
  changed()
  // Déjà autorisé lors d'une visite précédente : on rafraîchit l'inscription sans rien demander.
  if (online && supported && Notification.permission === 'granted') void register().catch(() => undefined)
}

export function pushStatus(): PushStatus {
  if (!online) return 'local'
  if (!supported) return 'unsupported'
  if (Notification.permission === 'denied') return 'denied'
  return token ? 'on' : 'off'
}

/** Demande l'autorisation puis inscrit cet appareil. */
export async function enablePush(): Promise<PushStatus> {
  if (!online || !supported) return pushStatus()
  const permission = await Notification.requestPermission()
  if (permission !== 'granted') {
    changed()
    return 'denied'
  }
  await register()
  return 'on'
}

export const testPush = (): Promise<{ sent: number; devices: number }> => api('/api/push/test', 'POST')

export const canInstall = (): boolean => installPrompt !== null
export async function installApp(): Promise<void> {
  if (!installPrompt) return
  await installPrompt.prompt()
  installPrompt = null
  changed()
}

/** iPhone / iPad dans Safari : il faut d'abord ajouter l'application à l'écran d'accueil. */
export const needsHomeScreen = (): boolean =>
  /iPhone|iPad|iPod/.test(navigator.userAgent) && !window.matchMedia('(display-mode: standalone)').matches
