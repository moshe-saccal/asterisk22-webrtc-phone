/** Server-provided configuration, account and user preferences. */

export interface DirectoryEntry {
  extension: string;
  name: string;
  type: 'webrtc' | 'sip';
}

export interface ServiceEntry {
  extension: string;
  name: string;
  description: string;
}

export interface ServerConfig {
  sipDomain: string;
  webSocketPath: string;
  iceServers: RTCIceServer[];
  directory: DirectoryEntry[];
  services: ServiceEntry[];
}

export interface Account {
  extension: string;
  password: string;
  displayName: string;
  /** SIP WebSocket URL, e.g. wss://pbx.example.com:8443/ws */
  server: string;
  /** Domain part of the SIP URIs. */
  domain: string;
}

export type VideoQuality = '360p' | '720p' | '1080p';

export interface Preferences {
  audioInput: string;
  videoInput: string;
  audioOutput: string;
  videoQuality: VideoQuality;
  echoCancellation: boolean;
  noiseSuppression: boolean;
  autoGainControl: boolean;
  ringtoneVolume: number;
  desktopNotifications: boolean;
}

export const DEFAULT_PREFERENCES: Preferences = {
  audioInput: '',
  videoInput: '',
  audioOutput: '',
  videoQuality: '720p',
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  ringtoneVolume: 0.6,
  desktopNotifications: true,
};

const FALLBACK_CONFIG: ServerConfig = {
  sipDomain: '',
  webSocketPath: '/ws',
  iceServers: [],
  directory: [],
  services: [],
};

export async function loadServerConfig(): Promise<ServerConfig> {
  try {
    const response = await fetch('/api/config', { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = (await response.json()) as Partial<ServerConfig>;
    return { ...FALLBACK_CONFIG, ...data };
  } catch (error) {
    console.warn('Could not load /api/config, using defaults', error);
    return FALLBACK_CONFIG;
  }
}

export function defaultServerUrl(config: ServerConfig): string {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${location.host}${config.webSocketPath || '/ws'}`;
}

export function defaultDomain(config: ServerConfig): string {
  return config.sipDomain || location.hostname;
}

// --- persistence -------------------------------------------------------------
const ACCOUNT_KEY = 'webphone.account';
const PREFS_KEY = 'webphone.preferences';

function read<T>(storage: Storage, key: string): T | undefined {
  try {
    const raw = storage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : undefined;
  } catch {
    return undefined;
  }
}

function write(storage: Storage, key: string, value: unknown): void {
  try {
    storage.setItem(key, JSON.stringify(value));
  } catch {
    // storage full or unavailable (private mode) — not fatal
  }
}

/** The account is kept in localStorage when "remember me" is ticked, otherwise for this tab only. */
export function loadAccount(): (Account & { remember: boolean }) | undefined {
  const remembered = read<Account>(localStorage, ACCOUNT_KEY);
  if (remembered) return { ...remembered, remember: true };
  const session = read<Account>(sessionStorage, ACCOUNT_KEY);
  return session ? { ...session, remember: false } : undefined;
}

export function saveAccount(account: Account, remember: boolean): void {
  clearAccount();
  write(remember ? localStorage : sessionStorage, ACCOUNT_KEY, account);
}

export function clearAccount(): void {
  try {
    localStorage.removeItem(ACCOUNT_KEY);
    sessionStorage.removeItem(ACCOUNT_KEY);
  } catch {
    // ignore
  }
}

export function loadPreferences(): Preferences {
  return { ...DEFAULT_PREFERENCES, ...read<Partial<Preferences>>(localStorage, PREFS_KEY) };
}

export function savePreferences(preferences: Preferences): void {
  write(localStorage, PREFS_KEY, preferences);
}
