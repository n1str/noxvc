// Строки поиска (ru/en). Подключаются в i18n.ts.
export const searchRu = {
  search: {
    placeholder: 'Поиск', placeholderDm: 'Поиск в переписке', filters: 'Фильтры поиска', results_one: '{{count}} результат', results_few: '{{count}} результата',
    results_many: '{{count}} результатов', results_other: '{{count}} результата', empty: 'Ничего не нашлось. Попробуйте другие слова или фильтры.', close: 'Закрыть поиск',
    sortNew: 'Сначала новые', sortOld: 'Сначала старые', sortRelevance: 'По релевантности', prev: 'Назад', next: 'Дальше', page: 'Стр. {{n}} из {{total}}',
    members: 'Участники', channels: 'Каналы', values: 'Значения', dates: 'Даты', today: 'сегодня', yesterday: 'вчера',
    f: {
      from: 'от пользователя', mentions: 'упоминает пользователя', in: 'в канале', has: 'ссылка, файл, картинка, видео, звук', before: 'до даты',
      after: 'после даты', during: 'в день', pinned: 'закреплённые',
    },
    has: { link: 'ссылка', file: 'файл', image: 'картинка', video: 'видео', audio: 'звук' },
  },
  media: { image: 'Изображение', original: 'Открыть оригинал', download: 'Скачать', close: 'Закрыть', prev: 'Предыдущее', next: 'Следующее', play: 'Смотреть видео', removeEmbeds: 'Убрать превью' },
};

export const searchEn: typeof searchRu = {
  search: {
    placeholder: 'Search', placeholderDm: 'Search conversation', filters: 'Search filters', results_one: '{{count}} result', results_few: '{{count}} results',
    results_many: '{{count}} results', results_other: '{{count}} results', empty: 'Nothing found. Try other words or filters.', close: 'Close search',
    sortNew: 'Newest first', sortOld: 'Oldest first', sortRelevance: 'Most relevant', prev: 'Back', next: 'Next', page: 'Page {{n}} of {{total}}',
    members: 'Members', channels: 'Channels', values: 'Values', dates: 'Dates', today: 'today', yesterday: 'yesterday',
    f: {
      from: 'from a user', mentions: 'mentions a user', in: 'in a channel', has: 'link, file, image, video, audio', before: 'before a date',
      after: 'after a date', during: 'on a day', pinned: 'pinned messages',
    },
    has: { link: 'link', file: 'file', image: 'image', video: 'video', audio: 'audio' },
  },
  media: { image: 'Image', original: 'Open original', download: 'Download', close: 'Close', prev: 'Previous', next: 'Next', play: 'Play video', removeEmbeds: 'Remove embeds' },
};
