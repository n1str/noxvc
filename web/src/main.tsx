import { StrictMode, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { MotionConfig } from 'motion/react';
import { useTranslation } from 'react-i18next';
import './lib/site'; // START_PATH / START_SEARCH — до замены адреса ниже
// /login и /register — экран входа в нужном режиме, адрес — корень
if (/^\/(login|register)\/?$/.test(location.pathname)) history.replaceState(null, '', '/' + location.hash); // ?code=… прочитан заранее (START_SEARCH)
import './i18n';
import { Logo } from './ui/Logo';
import { installClientLog } from './lib/clientLog';
installClientLog();
import { startTheme } from './lib/theme';
startTheme();
import './styles/tokens.css';
import './styles/base.css';
import { useStore } from './store';
import { Auth } from './features/Auth';
import { Shell } from './features/Shell';
import { ModalHost, PopoverHost, Toasts } from './ui/overlays';
import { TitleBar, useCustomTitlebar } from './features/titlebar';
import { restoreSession, watchFailover } from './features/endpoint';

try { if (localStorage.getItem('relay_reduced_motion') === 'true') document.documentElement.dataset.reducedMotion = 'true'; } catch { /* приватный режим */ }

function App() {
  const { t } = useTranslation();
  const token = useStore((s) => s.token);
  const me = useStore((s) => s.me);
  const connection = useStore((s) => s.connection);
  useEffect(() => { if (token && !me) useStore.getState().boot(); }, [token, me]);
  const reduced = document.documentElement.dataset.reducedMotion === 'true';
  const titlebar = useCustomTitlebar();
  return (
    <MotionConfig reducedMotion={reduced ? 'always' : 'user'}>
      <ModalHost>
        <PopoverHost>
          {titlebar && <TitleBar />}
          {!token ? <Auth /> : me ? <Shell /> : <div className="splash"><div className="brand"><Logo size={40} /></div></div>}
          {me && connection !== 'online' && <div className="conn-banner" role="status">{connection === 'reconnecting' ? t('app.reconnecting') : t('app.connecting')}</div>}
          <Toasts />
          <div id="audio-sink" hidden />
        </PopoverHost>
      </ModalHost>
    </MotionConfig>
  );
}

// Relay Desktop: вход, сохранённый приложением (другая точка входа — другой origin), — до первой отрисовки.
restoreSession().catch(() => {}).finally(() => {
  createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
  watchFailover();
});
