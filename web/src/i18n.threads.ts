// Строки веток, форумов и опросов (ru/en). Подключаются в i18n.ts.
export const threadsRu = {
  emojis: {
    hint: 'Свои эмодзи сервера: PNG, JPEG, WebP или GIF до 512 КБ (лучше квадратные 128×128). В тексте — :имя:.',
    upload: 'Загрузить эмодзи', count: '{{n}} из 50', name: 'Имя эмодзи', empty: 'Эмодзи пока нет', tooBig: '{{name}}: больше 512 КБ',
    deleteTitle: 'Удалить :{{name}}:?', deleteSub: 'В старых сообщениях вместо картинки останется :имя:.',
  },
  threads: {
    title: 'Ветки', active: 'Активные', archived: 'Архив', none: 'Веток пока нет', noneArchived: 'В архиве пусто', create: 'Создать ветку', open: 'Открыть ветку',
    name: 'Название ветки', createTitle: 'Новая ветка', fromMessage: 'Ветка из сообщения', count_one: '{{count}} сообщение', count_few: '{{count}} сообщения',
    count_many: '{{count}} сообщений', count_other: '{{count}} сообщения', welcome: 'Начало ветки «{{name}}»', welcomeSub: 'Здесь обсуждают отдельную тему, не засоряя канал.',
    toStarter: 'К исходному сообщению', follow: 'Следить за веткой', unfollow: 'Не следить', archive: 'Отправить в архив', unarchive: 'Вернуть из архива',
    lock: 'Закрыть ветку', unlock: 'Открыть ветку для всех', rename: 'Переименовать', delete: 'Удалить ветку', deleteSub: 'Все сообщения ветки будут удалены.',
    archivedBadge: 'в архиве', lockedBadge: 'закрыта', lockedNote: 'Ветка закрыта модератором', archivedPlaceholder: 'Ветка в архиве — новое сообщение вернёт её',
    more: 'Ещё', actions: 'Действия с веткой',
  },
  forum: {
    newPost: 'Новый пост', title: 'Заголовок', content: 'Текст поста', tags: 'Теги', allTags: 'Все', sortActivity: 'По активности', sortCreated: 'По дате создания',
    empty: 'Постов пока нет. Начните первое обсуждение!', emptyFilter: 'Нет постов с этим тегом', editTags: 'Теги форума', tagName: 'Тег', tagEmoji: 'Эмодзи',
    addTag: 'Добавить тег', guidelines: 'Правила форума', kindForum: 'Форум', kindText: 'Текстовый', kind: 'Тип канала', more: 'Показать ещё', post: 'Опубликовать',
  },
  poll: {
    create: 'Опрос', title: 'Новый опрос', question: 'Вопрос', answer: 'Вариант {{n}}', addAnswer: 'Добавить вариант', multiselect: 'Можно выбрать несколько',
    duration: 'Длительность', h1: '1 час', h4: '4 часа', h8: '8 часов', h24: '24 часа', d3: '3 дня', w1: 'Неделя', send: 'Опубликовать',
    single: 'Выберите один вариант', multi: 'Можно выбрать несколько', vote: 'Голосовать', unvote: 'Отменить голос', end: 'Завершить',
    ended: 'Опрос завершён', left: 'осталось {{time}}', votes_one: '{{count}} голос', votes_few: '{{count}} голоса', votes_many: '{{count}} голосов', votes_other: '{{count}} голоса',
    d: '{{n}} д', h: '{{n}} ч', m: '{{n}} мин',
  },
};

export const threadsEn: typeof threadsRu = {
  emojis: {
    hint: 'Custom server emoji: PNG, JPEG, WebP or GIF up to 512 KB (square 128×128 works best). Type :name: to use.',
    upload: 'Upload emoji', count: '{{n}} of 50', name: 'Emoji name', empty: 'No emoji yet', tooBig: '{{name}}: larger than 512 KB',
    deleteTitle: 'Delete :{{name}}:?', deleteSub: 'Old messages will show :name: instead of the image.',
  },
  threads: {
    title: 'Threads', active: 'Active', archived: 'Archived', none: 'No threads yet', noneArchived: 'Nothing archived', create: 'Create thread', open: 'Open thread',
    name: 'Thread name', createTitle: 'New thread', fromMessage: 'Thread from message', count_one: '{{count}} message', count_few: '{{count}} messages',
    count_many: '{{count}} messages', count_other: '{{count}} messages', welcome: 'Start of the “{{name}}” thread', welcomeSub: 'A place for a separate topic without cluttering the channel.',
    toStarter: 'Go to original message', follow: 'Follow thread', unfollow: 'Unfollow', archive: 'Archive thread', unarchive: 'Unarchive',
    lock: 'Lock thread', unlock: 'Unlock thread', rename: 'Rename', delete: 'Delete thread', deleteSub: 'All messages in the thread will be deleted.',
    archivedBadge: 'archived', lockedBadge: 'locked', lockedNote: 'This thread is locked by a moderator', archivedPlaceholder: 'Thread is archived — a new message will reopen it',
    more: 'More', actions: 'Thread actions',
  },
  forum: {
    newPost: 'New post', title: 'Title', content: 'Post text', tags: 'Tags', allTags: 'All', sortActivity: 'Recent activity', sortCreated: 'Creation date',
    empty: 'No posts yet. Start the first discussion!', emptyFilter: 'No posts with this tag', editTags: 'Forum tags', tagName: 'Tag', tagEmoji: 'Emoji',
    addTag: 'Add tag', guidelines: 'Forum guidelines', kindForum: 'Forum', kindText: 'Text', kind: 'Channel type', more: 'Show more', post: 'Post',
  },
  poll: {
    create: 'Poll', title: 'New poll', question: 'Question', answer: 'Answer {{n}}', addAnswer: 'Add answer', multiselect: 'Allow multiple answers',
    duration: 'Duration', h1: '1 hour', h4: '4 hours', h8: '8 hours', h24: '24 hours', d3: '3 days', w1: '1 week', send: 'Post',
    single: 'Select one answer', multi: 'Select one or more answers', vote: 'Vote', unvote: 'Remove vote', end: 'End poll',
    ended: 'Poll ended', left: '{{time}} left', votes_one: '{{count}} vote', votes_few: '{{count}} votes', votes_many: '{{count}} votes', votes_other: '{{count}} votes',
    d: '{{n}}d', h: '{{n}}h', m: '{{n}}m',
  },
};
