// Строки непрочитанного, «Входящих» и уведомлений (ru/en). Подключаются в i18n.ts.
export const notifyRu = {
  notify: {
    title: 'Настройки уведомлений', titleFor: 'Уведомления: {{name}}', save: 'Сохранить',
    level: 'Уведомлять о сообщениях', inherit: 'Как на сервере ({{level}})', all: 'Обо всех сообщениях', mentions: 'Только об @упоминаниях', nothing: 'Ничего',
    mute: 'Заглушить', muteNone: 'Не заглушать', mute15: 'На 15 минут', mute1h: 'На 1 час', mute8h: 'На 8 часов', mute24h: 'На 24 часа', muteForever: 'Пока не включу', mutedUntil: 'Заглушено до {{time}}',
    muteHint: 'Заглушённое не подсвечивается и не издаёт звуков; упоминания всё равно считаются.',
    suppressEveryone: 'Не учитывать @everyone', device: 'На этом устройстве', sound: 'Звук новых сообщений', desktop: 'Уведомления на рабочем столе',
    desktopDenied: 'Браузер запретил уведомления — разрешите их в настройках сайта',
    markRead: 'Отметить как прочитанное', menu: 'Уведомления', muted: 'заглушено',
  },
  inbox: {
    title: 'Упоминания', open: 'Входящие', empty: 'Здесь будут упоминания и ответы на ваши сообщения.', more: 'Загрузить ещё', dm: 'Личные сообщения',
  },
};

export const notifyEn: typeof notifyRu = {
  notify: {
    title: 'Notification settings', titleFor: 'Notifications: {{name}}', save: 'Save',
    level: 'Notify me about', inherit: 'Server default ({{level}})', all: 'All messages', mentions: 'Only @mentions', nothing: 'Nothing',
    mute: 'Mute', muteNone: 'Not muted', mute15: 'For 15 minutes', mute1h: 'For 1 hour', mute8h: 'For 8 hours', mute24h: 'For 24 hours', muteForever: 'Until I turn it back on', mutedUntil: 'Muted until {{time}}',
    muteHint: 'Muted places are not highlighted and make no sound; mentions are still counted.',
    suppressEveryone: 'Suppress @everyone', device: 'On this device', sound: 'New message sound', desktop: 'Desktop notifications',
    desktopDenied: 'The browser blocked notifications — allow them in site settings',
    markRead: 'Mark as read', menu: 'Notifications', muted: 'muted',
  },
  inbox: {
    title: 'Mentions', open: 'Inbox', empty: 'Mentions and replies to your messages will show up here.', more: 'Load more', dm: 'Direct messages',
  },
};
