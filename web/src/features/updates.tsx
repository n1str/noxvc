// Автообновление Relay Desktop: приложение само проверяет и скачивает новую версию (подписанную),
// здесь — индикатор «обновление готово» в панели серверов и блок в «Приложение».
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Download, RefreshCw } from 'lucide-react';
import { Button } from '../ui';
import { dcall, dlisten, isDesktop } from '../lib/desktop';

export interface UpdateReady { version: string; notes: string }

/** Готовое (скачанное и проверенное) обновление или null. */
export function useUpdate() {
  const [ready, setReady] = useState<UpdateReady | null>(null);
  useEffect(() => {
    if (!isDesktop) return;
    dcall<UpdateReady | null>('update_status').then(setReady, () => {});
    return dlisten<UpdateReady>('update_ready', setReady);
  }, []);
  return [ready, setReady] as const;
}

const install = () => dcall('update_install').catch(() => {});

/** Зелёная кнопка в панели серверов (как в Discord): обновление скачано — перезапустить. */
export function UpdateButton() {
  const { t } = useTranslation();
  const [ready] = useUpdate();
  if (!ready) return null;
  const label = t('app.updateReady', { version: ready.version });
  return (
    <button className="rail-btn rail-update" aria-label={label} title={label} onClick={install}>
      <Download size={20} />
    </button>
  );
}

/** Блок «Обновления» во вкладке «Приложение». */
export function UpdateRow({ version }: { version: string }) {
  const { t } = useTranslation();
  const [ready, setReady] = useUpdate();
  const [state, setState] = useState<'idle' | 'checking' | 'latest' | string>('idle');
  const check = async () => {
    setState('checking');
    try {
      const r = await dcall<UpdateReady | null>('update_check');
      setReady(r);
      setState(r ? 'idle' : 'latest');
    } catch (e) { setState((e as Error).message); }
  };
  return (
    <div className="us-row update-row">
      <div>
        <span className="muted small">{t('app.version')}</span>
        <div>NoxVC Desktop {version}</div>
        <div className="muted small">
          {ready ? t('app.updateReady', { version: ready.version })
            : state === 'checking' ? t('app.updateChecking')
            : state === 'latest' ? t('app.updateLatest')
            : state === 'idle' ? t('app.updateAuto')
            : state}
        </div>
        {ready?.notes && <div className="small update-notes">{ready.notes}</div>}
      </div>
      {ready
        ? <Button variant="primary" onClick={install}><Download size={16} /> {t('app.updateInstall')}</Button>
        : <Button variant="ghost" disabled={state === 'checking'} onClick={check}><RefreshCw size={16} /> {t('app.updateCheck')}</Button>}
    </div>
  );
}
