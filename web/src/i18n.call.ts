// Строки фазы 5: звонки, видео, демонстрация экрана, сцена (ru/en). Подключаются в i18n.ts.
export const callRu = {
  picker: { apps: 'Приложения', screens: 'Экраны', refresh: 'Обновить список', empty: 'Нечего показать — откройте окно и обновите список.', goLive: 'Начать трансляцию', quality: 'Качество: {{res}}, {{fps}} FPS — изменить' },
  stream: {
    title: 'Демонстрация экрана', titleLive: 'Качество трансляции', start: 'Начать демонстрацию', apply: 'Применить', applied: 'Качество трансляции обновлено',
    liveHint: 'Разрешение, FPS, режим и битрейт меняются сразу, без повторного выбора окна. Кодек — со следующего запуска.',
    encoder: 'Кодирование', encAuto: 'Авто', encGpu: 'Видеокарта', encCpu: 'Процессор', encNow: 'Сейчас: {{name}}',
    encHint: 'Видеокарта (NVIDIA, AMD, Intel) даёт более чёткую картинку на том же битрейте и почти не нагружает процессор — играм это не мешает. «Авто» сам переключится на процессор, если видеокарта не умеет кодировать.',
    resolution: 'Разрешение', source: 'Исходное', fps: 'Частота кадров', mode: 'Оптимизация', modeAuto: 'Авто', modeMotion: 'Плавность', modeDetail: 'Чёткость',
    modeHint_auto: 'Браузер сам балансирует плавность и чёткость.', modeHint_motion: 'Для игр и видео: при нехватке канала держим FPS, снижаем разрешение.',
    modeHint_detail: 'Для кода, текста и документов: держим разрешение, при нехватке канала снижаем FPS.',
    surface: 'Что показывать', surfAny: 'Выбор в окне', surfScreen: 'Весь экран', surfWindow: 'Окно', surfTab: 'Вкладка', audio: 'Транслировать звук (стерео)', audioOn: 'Включить звук трансляции', audioOff: 'Выключить звук трансляции', audioNone: 'У трансляции нет звука', audioLive: 'Звук трансляции сейчас', audioMutedState: 'Трансляция без звука', audioNotCaptured: 'Звук не захвачен: браузер даёт звук только если при выборе отметить «Поделиться звуком» (вкладка или весь экран)', audioUnavailable: 'Звук трансляции недоступен на этой версии Windows (нужна Windows 11)', audioUpdateApp: 'Чтобы выключать звук трансляции отдельно, обновите приложение NoxVC',
    advanced: 'Дополнительно: кодек и битрейт', hideAdvanced: 'Скрыть дополнительные', codec: 'Кодек', bitrate: 'Битрейт', auto: 'Авто', mbps: 'Мбит/с',
    codecHint: 'Сейчас: {{codec}}. «Авто»: H.264, если браузер кодирует его видеокартой, иначе VP8 (быстрее программного H.264); VP9/AV1 — чётче текст на том же битрейте (больше нагрузка на процессор).',
    camera: 'Камера', viewing: 'Просмотр', viewMax: 'Всегда смотреть в максимальном качестве', viewHint: 'Иначе качество подстраивается под размер плитки и экономит трафик. Применится при следующем подключении.',
    stats: 'Статистика потока',
  },
  call: {
    live: 'В ЭФИРЕ', fullscreen: 'Во весь экран', exitFullscreen: 'Выйти из полноэкранного режима', join: 'Присоединиться', joinVideo: 'С камерой', joinCall: 'Присоединиться к звонку',
    joinStage: 'Войти как слушатель', cameraOn: 'Включить камеру', cameraOff: 'Выключить камеру', screenOn: 'Демонстрация экрана', screenOff: 'Остановить демонстрацию',
    raiseHand: 'Поднять руку', lowerHand: 'Опустить руку', toAudience: 'Стать слушателем', moveToAudience: 'Сделать слушателем', inviteSpeak: 'Пригласить выступить',
    handRaised: 'Поднял руку', speakers: 'Выступают — {{n}}', audience: 'Слушатели — {{n}}', noSpeakers: 'Пока никто не выступает.',
    empty: 'Здесь пока никого. Присоединяйтесь — остальные увидят вас в канале.', stageEmpty: 'Сцена пуста. Модераторы могут начать выступление.',
    start: 'Позвонить', startVideo: 'Видеозвонок', incoming: 'Входящий звонок', incomingGroup: 'Звонок в «{{name}}»', accept: 'Ответить', acceptVideo: 'Ответить с камерой', decline: 'Отклонить',
    inCall: 'Идёт звонок', kindVoice: 'Голосовой', kindStage: 'Сцена',
  },
};

export const callEn: typeof callRu = {
  picker: { apps: 'Applications', screens: 'Screens', refresh: 'Refresh', empty: 'Nothing to share — open a window and refresh.', goLive: 'Go Live', quality: 'Quality: {{res}}, {{fps}} FPS — change' },
  stream: {
    title: 'Screen share', titleLive: 'Stream quality', start: 'Go live', apply: 'Apply', applied: 'Stream quality updated',
    liveHint: 'Resolution, FPS, mode and bitrate apply instantly without re-picking the window. Codec applies on next start.',
    encoder: 'Encoding', encAuto: 'Auto', encGpu: 'Graphics card', encCpu: 'Processor', encNow: 'Now: {{name}}',
    encHint: 'Graphics card (NVIDIA, AMD, Intel) gives a sharper picture at the same bitrate and barely loads the CPU, so games are unaffected. Auto falls back to the processor if the GPU cannot encode.',
    resolution: 'Resolution', source: 'Source', fps: 'Frame rate', mode: 'Optimize for', modeAuto: 'Auto', modeMotion: 'Smoothness', modeDetail: 'Clarity',
    modeHint_auto: 'The browser balances smoothness and clarity.', modeHint_motion: 'For games and video: keeps FPS, lowers resolution when bandwidth is short.',
    modeHint_detail: 'For code, text and documents: keeps resolution, lowers FPS when bandwidth is short.',
    surface: 'What to share', surfAny: 'Pick in dialog', surfScreen: 'Entire screen', surfWindow: 'Window', surfTab: 'Tab', audio: 'Share audio (stereo)', audioOn: 'Unmute stream audio', audioOff: 'Mute stream audio', audioNone: 'Stream has no audio', audioLive: 'Stream audio now', audioMutedState: 'Stream is muted', audioNotCaptured: 'No audio captured: the browser only shares audio if you tick “Share audio” when choosing (tab or entire screen)', audioUnavailable: 'Stream audio is not available on this Windows version (Windows 11 required)', audioUpdateApp: 'Update the NoxVC app to mute stream audio separately',
    advanced: 'Advanced: codec and bitrate', hideAdvanced: 'Hide advanced', codec: 'Codec', bitrate: 'Bitrate', auto: 'Auto', mbps: 'Mbps',
    codecHint: 'Current: {{codec}}. Auto: H.264 if the browser encodes it on the GPU, otherwise VP8 (faster than software H.264); VP9/AV1 — sharper text at the same bitrate (more CPU).',
    camera: 'Camera', viewing: 'Viewing', viewMax: 'Always watch in maximum quality', viewHint: 'Otherwise quality adapts to tile size to save bandwidth. Applies on next connect.',
    stats: 'Stream stats',
  },
  call: {
    live: 'LIVE', fullscreen: 'Fullscreen', exitFullscreen: 'Exit fullscreen', join: 'Join voice', joinVideo: 'Join with video', joinCall: 'Join call',
    joinStage: 'Join as listener', cameraOn: 'Turn on camera', cameraOff: 'Turn off camera', screenOn: 'Share screen', screenOff: 'Stop sharing',
    raiseHand: 'Raise hand', lowerHand: 'Lower hand', toAudience: 'Move to audience', moveToAudience: 'Move to audience', inviteSpeak: 'Invite to speak',
    handRaised: 'Hand raised', speakers: 'Speakers — {{n}}', audience: 'Audience — {{n}}', noSpeakers: 'No one is speaking yet.',
    empty: 'No one is here yet. Join — others will see you in the channel.', stageEmpty: 'The stage is empty. Moderators can start speaking.',
    start: 'Start call', startVideo: 'Start video call', incoming: 'Incoming call', incomingGroup: 'Call in “{{name}}”', accept: 'Accept', acceptVideo: 'Accept with video', decline: 'Decline',
    inCall: 'Call in progress', kindVoice: 'Voice', kindStage: 'Stage',
  },
};
