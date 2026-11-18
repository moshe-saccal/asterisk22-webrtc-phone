import './styles.css';
import { loadAccount, loadPreferences, loadServerConfig, saveAccount, type Account, type ServerConfig } from './config';
import { TonePlayer } from './media/tones';
import { Phone } from './sip/phone';
import { PhoneApp } from './ui/app';
import { h } from './ui/dom';
import { icon } from './ui/icons';
import { LoginView } from './ui/login';

const root = document.getElementById('app')!;
const tones = new TonePlayer();
const preferences = loadPreferences();
let app: PhoneApp | undefined;

function unsupportedReason(): string | undefined {
  if (!window.isSecureContext) {
    return `Calls need a secure connection. Open https://${location.host}${location.pathname} instead.`;
  }
  if (!('RTCPeerConnection' in window) || !navigator.mediaDevices?.getUserMedia) {
    return 'This browser does not support WebRTC calling. Use a current version of Chrome, Edge, Firefox or Safari.';
  }
  return undefined;
}

function showSplash(message: string): void {
  root.replaceChildren(
    h('div', { class: 'splash' }, h('div', { class: 'brand-mark brand-mark-lg' }, icon('logo', 30)), h('span', { class: 'spinner' }), h('p', { class: 'muted' }, message)),
  );
}

function showLogin(config: ServerConfig, initial: Partial<Account> & { remember?: boolean }, error?: string): void {
  const view = new LoginView(config, initial, async ({ account, remember }) => {
    tones.unlock();
    if (preferences.desktopNotifications && 'Notification' in window && Notification.permission === 'default') {
      void Notification.requestPermission();
    }
    await signIn(config, account, remember);
  });
  root.replaceChildren(view.el);
  if (error) view.showError(error);
}

async function signIn(config: ServerConfig, account: Account, remember: boolean): Promise<void> {
  const phone = new Phone(account, {
    iceServers: config.iceServers,
    getPreferences: () => app?.getPreferences() ?? preferences,
  });
  await phone.start();
  saveAccount(account, remember);
  app = new PhoneApp(phone, config, preferences, tones, () => {
    app?.destroy();
    app = undefined;
    showLogin(config, { ...account, password: '' });
  });
  root.replaceChildren(app.el);
}

async function boot(): Promise<void> {
  const problem = unsupportedReason();
  if (problem) {
    root.replaceChildren(h('div', { class: 'splash' }, icon('alert', 36), h('h1', {}, 'Cannot start the phone'), h('p', { class: 'muted' }, problem)));
    return;
  }
  showSplash('Loading…');
  const config = await loadServerConfig();
  const saved = loadAccount();
  if (!saved) {
    showLogin(config, {});
    return;
  }
  showSplash(`Signing in as ${saved.displayName || saved.extension}…`);
  try {
    await signIn(config, saved, saved.remember);
  } catch (error) {
    showLogin(config, saved, (error as Error).message);
  }
}

void boot();
