import { Capacitor } from '@capacitor/core';
import { SecureStorage } from '@aparajita/capacitor-secure-storage';
import { SocialLogin } from '@capgo/capacitor-social-login';
import { Contacts } from '@capacitor-community/contacts';
if (Capacitor.isNativePlatform()) {
  let token = null;
  const ready = (async () => { await SecureStorage.setKeyPrefix('picshare.'); await SecureStorage.setSynchronize(false); token = await SecureStorage.get('session'); })();
  window.PicShareNative = {
    ready, get token() { return token; },
    async setToken(value) { token = value; if (value) await SecureStorage.set('session', value); else await SecureStorage.remove('session'); },
    async googleLogin(contacts = false) {
      const response = await fetch(`${window.PICSHARE_API_URL}/auth/config`);
      const config = await response.json();
      if (!config.googleClientId) throw new Error('Google sign-in is not configured. You can create an account with email.');
      if (Capacitor.getPlatform() === 'ios' && !window.PICSHARE_IOS_GOOGLE_CLIENT_ID) throw new Error('Native Google sign-in needs the iOS OAuth client configuration. Use email for now.');
      await SocialLogin.initialize({ google: { webClientId: config.googleClientId, iOSClientId: window.PICSHARE_IOS_GOOGLE_CLIENT_ID, iOSServerClientId: config.googleClientId, mode: 'online' } });
      const { result } = await SocialLogin.login({ provider: 'google', options: { scopes: contacts ? ['email', 'profile', 'https://www.googleapis.com/auth/contacts.readonly'] : ['email', 'profile'] } });
      if (contacts) { if (!result.accessToken?.token) throw new Error('Google Contacts permission was not granted.'); return result.accessToken.token; }
      if (!result.idToken) throw new Error('Google did not return a sign-in token.');
      return result.idToken;
    },
    googleContacts() { return this.googleLogin(true); },
    async pickContacts() {
      const { contact } = await Contacts.pickContact({ projection: { name: true, emails: true } });
      return (contact.emails || []).map(e => e.address).filter(Boolean);
    }
  };
}
