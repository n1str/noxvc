import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { AnimatePresence, motion } from 'motion/react';
import { Lock } from 'lucide-react';
import { appear } from '../design/tokens';
import { Button, Input } from '../ui';
import { useStore } from '../store';
import { Logo } from '../ui/Logo';
import { START_PATH, START_SEARCH } from '../lib/site';

// NoxVC — закрытый сервис: регистрация только по коду приглашения (его проверяет сервер, src/invites.rs).
// /register?code=… — форма регистрации с подставленным кодом; ссылка на сервер (#invite/…) без входа — «только по
// приглашению» и вход, без формы регистрации.
const startCode = new URLSearchParams(START_SEARCH).get('code') ?? '';

export function Auth() {
  const { t } = useTranslation();
  const serverInvite = /^#invite\//.test(location.hash);
  const [register, setRegister] = useState(() => !serverInvite && (/^\/register\/?$/.test(START_PATH) || !!startCode));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    setBusy(true);
    setError('');
    try { await useStore.getState().login(String(fd.get('username')), String(fd.get('password')), register, register ? String(fd.get('code') ?? '') : undefined); }
    catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  };
  return (
    <div className="auth">
      <div className="ambient" aria-hidden />
      <motion.form className="auth-card" onSubmit={submit} initial={{ opacity: 0, y: 16, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={appear}>
        <div className="brand"><Logo size={30} /></div>
        {serverInvite && !register && (
          <div className="auth-closed" role="note">
            <Lock size={18} aria-hidden />
            <div><b>{t('auth.closed')}</b><p className="muted small">{t('auth.closedSub')}</p></div>
          </div>
        )}
        <AnimatePresence mode="wait" initial={false}>
          <motion.div key={String(register)} initial={{ opacity: 0, x: register ? 12 : -12 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }}>
            <h1>{register ? t('auth.create') : t('auth.welcome')}</h1>
            <p className="muted">{register ? t('auth.createSub') : t('auth.welcomeSub')}</p>
          </motion.div>
        </AnimatePresence>
        {register && <Input name="code" label={t('auth.code')} defaultValue={startCode} autoComplete="off" spellCheck={false} required autoFocus={!startCode} maxLength={64} />}
        <Input name="username" label={t('auth.username')} autoComplete="username" required autoFocus={!register || !!startCode} />
        <Input name="password" type="password" label={t('auth.password')} autoComplete={register ? 'new-password' : 'current-password'} required />
        {error && <p className="error" role="alert">{error}</p>}
        <Button type="submit" variant="primary" disabled={busy}>{register ? t('auth.register') : t('auth.login')}</Button>
        {!serverInvite && (
          <p className="muted small">
            {register ? t('auth.haveAccount') : t('auth.haveCode')}{' '}
            <button type="button" className="link" onClick={() => { setRegister(!register); setError(''); }}>{register ? t('auth.toLogin') : t('auth.toRegister')}</button>
          </p>
        )}
      </motion.form>
    </div>
  );
}
