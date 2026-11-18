import ReactDOM from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import App from './App';
import { createWebApi } from './lib/webApi';
import { initPush } from './lib/push';
import { isNative } from './lib/platform';
import { StatusBar as CapStatusBar, Style } from '@capacitor/status-bar';
import type { MainApi } from '@shared/types';
import './index.css';

// Outside Electron (PWA / Capacitor WebView) there is no preload — install the
// browser-backed shim so every window.api call site works unchanged.
if (typeof (window as unknown as { api?: unknown }).api === 'undefined') {
  (window as unknown as { api: MainApi }).api = createWebApi();
}

if (isNative()) {
  // WebView runs edge-to-edge under the system status bar — push content below
  // it instead of overlapping (bg matches the header so the seam is invisible).
  void CapStatusBar.setOverlaysWebView({ overlay: false })
    .then(() => CapStatusBar.setBackgroundColor({ color: '#0f172a' }))
    .then(() => CapStatusBar.setStyle({ style: Style.Dark }))
    .catch(() => {});
}

// Android shell: FCM registration + native call notifications (no-op on web).
// Deferred past first render so native startup can never block launch.
setTimeout(() => {
  void initPush().catch(() => {});
}, 1500);

// StrictMode removed: it double-invokes effects in dev (mount→cleanup→mount),
// which caused two SipService.initialize() calls and duplicate SIP UAs.
// The SipService now has its own init guard, but removing StrictMode eliminates
// the race window entirely and avoids unnecessary disconnect/reconnect churn.
ReactDOM.createRoot(document.getElementById('root')!).render(
  <HashRouter>
    <App />
  </HashRouter>,
);
