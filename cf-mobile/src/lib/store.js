// Device settings. There are no user accounts: a phone remembers which server it talks to,
// which event it is working, and the first name of whoever is holding it. That is the whole
// identity model, and it is deliberate — nobody should be typing a password at a stall.

import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';

const KEY = 'cf.settings.v1';

const extra = Constants.expoConfig?.extra || {};

const DEFAULTS = {
  apiUrl: extra.defaultApiUrl || '',
  deviceKey: extra.defaultDeviceKey || '',
  staffName: '',
  deviceLabel: '',
  eventId: '',
  eventName: '',
  interestTags: [],
};

let cache = null;

export async function getSettings() {
  if (cache) return cache;
  try {
    const raw = await AsyncStorage.getItem(KEY);
    cache = { ...DEFAULTS, ...(raw ? JSON.parse(raw) : {}) };
  } catch {
    cache = { ...DEFAULTS };
  }
  return cache;
}

export async function saveSettings(patch) {
  const next = { ...(await getSettings()), ...patch };
  cache = next;
  await AsyncStorage.setItem(KEY, JSON.stringify(next));
  return next;
}

export function isConfigured(s) {
  return Boolean(s?.apiUrl && s?.deviceKey && s?.staffName && s?.eventId);
}

/** Accepts a bare host, a full URL, or the JSON payload from the admin's setup QR. */
export function parseSetupPayload(scanned) {
  const text = String(scanned || '').trim();
  try {
    const json = JSON.parse(text);
    if (json && (json.api || json.key)) {
      return { apiUrl: normaliseUrl(json.api || ''), deviceKey: json.key || '' };
    }
  } catch {
    // not JSON — fall through and treat it as a URL
  }
  if (/^https?:\/\//i.test(text) || /^[\w.-]+(:\d+)?$/.test(text)) {
    return { apiUrl: normaliseUrl(text), deviceKey: '' };
  }
  return null;
}

export function normaliseUrl(u) {
  let s = String(u || '').trim().replace(/\/+$/, '');
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  return s;
}
