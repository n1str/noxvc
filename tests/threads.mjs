// Фаза 3e: ветки (из сообщения и отдельные), права от родителя, архив/закрытие, форум (посты, теги), опросы.
//   RELAY_URL=http://127.0.0.1:8099 node tests/threads.mjs
import { api, gatewayConnect, wait } from './lib.mjs';

let fails = 0;
const ok = (c, msg) => { console.log((c ? 'OK  ' : 'FAIL') + ' ' + msg); if (!c) fails++; };
const sfx = Date.now() % 100000;
const reg = async (n) => (await api(null, 'POST', '/register', { username: n + sfx, password: 'secret12' })).data;
const owner = await reg('to'), user = await reg('tu'), outsider = await reg('tx');
const g = (await api(owner.token, 'POST', '/guilds', { name: 'Ветки' })).data;
const { code } = (await api(owner.token, 'POST', `/guilds/${g.id}/invites`)).data;
await api(user.token, 'POST', `/invites/${code}`);
const gd = (await api(owner.token, 'GET', `/guilds/${g.id}`)).data;
const text = gd.channels.find((c) => c.kind === 'text');
const everyone = gd.roles.find((r) => r.is_default);
const post = (tok, ch, body) => api(tok, 'POST', `/channels/${ch}/messages`, typeof body === 'string' ? { content: body } : body);
const gwUser = await gatewayConnect(user.token);

// ---------- ветка из сообщения ----------
const starter = (await post(owner.token, text.id, 'Обсудим релиз?')).data;
const th = await api(user.token, 'POST', `/channels/${text.id}/threads`, { message_id: starter.id });
ok(th.status === 200 && th.data.kind === 'thread' && th.data.parent_id === text.id && th.data.name === 'Обсудим релиз?', 'ветка из сообщения: имя по тексту сообщения');
ok(th.data.thread.starter_message_id === starter.id && th.data.thread.owner_id === user.user.id, 'метаданные: стартовое сообщение и автор');
ok((await api(owner.token, 'POST', `/channels/${text.id}/threads`, { message_id: starter.id })).status === 400, 'вторая ветка у того же сообщения — 400');
await wait(150);
ok(gwUser.events.some((e) => e.type === 'thread_create' && e.thread.id === th.data.id), 'thread_create по gateway');
ok(gwUser.events.some((e) => e.type === 'thread_member' && e.thread_id === th.data.id && e.joined), 'автор ветки — её участник');
const starterNow = (await api(owner.token, 'GET', `/channels/${text.id}/messages?around=${starter.id}&limit=1`)).data.find((m) => m.id === starter.id);
ok(starterNow.thread?.id === th.data.id, 'у стартового сообщения есть ссылка на ветку');

// сообщения в ветке
const r1 = await post(owner.token, th.data.id, 'Я за, в пятницу');
ok(r1.status === 200 && r1.data.channel_id === th.data.id, 'писать в ветку');
await wait(150);
const upd = gwUser.events.filter((e) => e.type === 'thread_update' && e.thread.id === th.data.id).at(-1);
ok(upd?.thread.thread.message_count === 1, 'thread_update: счётчик сообщений');
let detail = (await api(owner.token, 'GET', `/guilds/${g.id}`)).data;
ok(detail.threads.some((t) => t.id === th.data.id) && !detail.channels.some((c) => c.id === th.data.id), 'активные ветки — отдельным списком в сервере');
ok(detail.joined_threads.includes(th.data.id), 'написавший в ветку — её участник');
ok((await api(owner.token, 'GET', '/me')).data.read_states.some((r) => r.channel_id === th.data.id), 'ветка участвует в непрочитанном');
ok((await api(user.token, 'GET', `/search?guild_id=${g.id}&q=${encodeURIComponent('пятниц')}`)).data.total === 1, 'сообщения веток ищутся');

// права от родителя: закрыли родителя — ветка недоступна
const secret = (await api(owner.token, 'POST', `/guilds/${g.id}/channels`, { name: 'секрет' })).data;
const sth = (await api(owner.token, 'POST', `/channels/${secret.id}/threads`, { name: 'тайная ветка' })).data;
await api(owner.token, 'PUT', `/channels/${secret.id}/permissions/role/${everyone.id}`, { allow: 0, deny: 1024 });
ok((await post(user.token, sth.id, 'проникаю')).status === 404, 'ветка скрытого канала недоступна');
ok(!(await api(user.token, 'GET', `/guilds/${g.id}`)).data.threads.some((t) => t.id === sth.id), 'и не видна в списке');
// SEND_MESSAGES_IN_THREADS
await api(owner.token, 'PUT', `/channels/${text.id}/permissions/role/${everyone.id}`, { allow: 0, deny: 2 ** 38 });
ok((await post(user.token, th.data.id, 'можно?')).status === 403, 'без SEND_MESSAGES_IN_THREADS писать в ветку нельзя');
ok((await post(user.token, text.id, 'а в канал можно')).status === 200, 'а в сам канал — можно');
await api(owner.token, 'PUT', `/channels/${text.id}/permissions/role/${everyone.id}`, { allow: 0, deny: 2 ** 35 });
ok((await api(user.token, 'POST', `/channels/${text.id}/threads`, { name: 'ещё' })).status === 403, 'без CREATE_THREADS ветку не создать');
await api(owner.token, 'DELETE', `/channels/${text.id}/permissions/role/${everyone.id}`);

// архив и закрытие
ok((await api(user.token, 'PATCH', `/threads/${th.data.id}`, { archived: true })).data.thread.archived === true, 'автор архивирует ветку');
let list = (await api(user.token, 'GET', `/channels/${text.id}/threads`)).data;
ok(!list.threads.some((t) => t.id === th.data.id), 'архивная ветка не в активных');
list = (await api(user.token, 'GET', `/channels/${text.id}/threads?archived=true`)).data;
ok(list.threads.some((t) => t.id === th.data.id), 'а в архивных — есть');
await post(user.token, th.data.id, 'возвращаю');
ok((await api(user.token, 'GET', `/channels/${text.id}/threads`)).data.threads.some((t) => t.id === th.data.id), 'новое сообщение разархивирует');
ok((await api(user.token, 'PATCH', `/threads/${th.data.id}`, { locked: true })).status === 403, 'закрыть ветку может только модератор');
ok((await api(owner.token, 'PATCH', `/threads/${th.data.id}`, { locked: true })).data.thread.locked === true, 'модератор закрыл');
ok((await post(user.token, th.data.id, 'а я пишу')).status === 403, 'в закрытую ветку не написать');
ok((await post(owner.token, th.data.id, 'модератору можно')).status === 200, 'модератору — можно');
ok((await api(user.token, 'PATCH', `/threads/${th.data.id}`, { name: 'новое' })).status === 403, 'автор не меняет закрытую ветку');
ok((await api(owner.token, 'PATCH', `/threads/${th.data.id}`, { auto_archive_minutes: 5 })).status === 400, 'автоархив — только из списка');
ok((await api(outsider.token, 'PATCH', `/threads/${th.data.id}`, { name: 'x' })).status === 404, 'чужой — 404');

// участие
ok((await api(user.token, 'DELETE', `/threads/${th.data.id}/members/me`)).data.joined === false, 'выйти из ветки');
ok(!(await api(user.token, 'GET', `/guilds/${g.id}`)).data.joined_threads.includes(th.data.id), 'и её нет в моих');
ok((await api(user.token, 'PUT', `/threads/${th.data.id}/members/me`)).data.joined === true, 'вступить снова');

// ---------- форум ----------
const forum = (await api(owner.token, 'POST', `/guilds/${g.id}/channels`, { name: 'Вопросы и Ответы', kind: 'forum' })).data;
ok(forum.kind === 'forum' && forum.name === 'вопросы-и-ответы', 'форум создан');
const tags = await api(owner.token, 'PUT', `/channels/${forum.id}/tags`, [{ name: 'Баг', emoji: '🐞' }, { name: 'Идея', emoji: '💡' }, { name: 'Вопрос' }]);
ok(tags.status === 200 && tags.data.tags.length === 3 && tags.data.tags[0].name === 'Баг', 'теги форума');
ok((await api(user.token, 'PUT', `/channels/${forum.id}/tags`, [])).status === 403, 'теги меняет только MANAGE_CHANNELS');
const [bug, idea, question] = tags.data.tags;
ok((await post(user.token, forum.id, 'прямо в форум')).status === 400, 'в форум нельзя писать напрямую');
ok((await api(user.token, 'POST', `/channels/${forum.id}/threads`, { name: 'пустой' })).status === 400, 'пустой пост — 400');
ok((await api(user.token, 'POST', `/channels/${forum.id}/threads`, { name: 'x', content: 'y', applied_tags: [999999] })).status === 400, 'чужой тег — 400');
const p1 = await api(user.token, 'POST', `/channels/${forum.id}/threads`, { name: 'Падает загрузка файлов', content: 'Файл >10 МБ не грузится', applied_tags: [bug.id] });
ok(p1.status === 200 && p1.data.thread.applied_tags[0] === bug.id && p1.data.thread.message_count === 1, 'пост форума: ветка + первое сообщение + тег');
await post(owner.token, forum.id === 0 ? 0 : p1.data.id, 'Посмотрю');
await wait(20);
const p2 = (await api(owner.token, 'POST', `/channels/${forum.id}/threads`, { name: 'Тёмная тема для кода', content: 'Хочу', applied_tags: [idea.id, question.id] })).data;
const posts = (await api(user.token, 'GET', `/channels/${forum.id}/threads`)).data;
ok(posts.threads.length === 2 && posts.threads[0].id === p2.id, 'посты: по последней активности');
ok(posts.threads.find((t) => t.id === p1.data.id).first_message.content === 'Файл >10 МБ не грузится', 'у поста — первое сообщение');
ok((await api(user.token, 'GET', `/channels/${forum.id}/threads?sort=created`)).data.threads[0].id === p2.id, 'сортировка по дате создания');
ok((await api(user.token, 'PATCH', `/threads/${p1.data.id}`, { applied_tags: [bug.id, question.id] })).data.thread.applied_tags.length === 2, 'автор меняет теги');
await api(owner.token, 'PUT', `/channels/${forum.id}/tags`, [{ id: bug.id, name: 'Ошибка', emoji: '🐞' }, { id: idea.id, name: 'Идея' }]);
const p1after = (await api(user.token, 'GET', `/channels/${forum.id}/threads`)).data.threads.find((t) => t.id === p1.data.id);
ok(p1after.thread.applied_tags.length === 1 && p1after.thread.applied_tags[0] === bug.id, 'удалённый тег снят с постов');
ok((await api(user.token, 'DELETE', `/threads/${p2.id}`)).status === 403, 'чужой пост удалить нельзя');
ok((await api(owner.token, 'DELETE', `/threads/${p2.id}`)).status === 200, 'модератор удаляет пост');

// ---------- опросы ----------
const pollMsg = await post(owner.token, text.id, { content: '', poll: { question: 'Когда созвон?', answers: ['Пятница', 'Суббота', 'Воскресенье'], duration_hours: 24 } });
ok(pollMsg.status === 200 && pollMsg.data.poll.answers.length === 3 && pollMsg.data.poll.question === 'Когда созвон?', 'опрос создан');
ok((await post(owner.token, text.id, { content: '', poll: { question: 'q', answers: ['один'] } })).status === 400, 'опрос с одним вариантом — 400');
ok((await post(owner.token, text.id, { content: '', poll: { question: 'q', answers: ['a', 'b'], duration_hours: 1000 } })).status === 400, 'слишком долгий опрос — 400');
const pid = pollMsg.data.id;
let v = await api(user.token, 'PUT', `/messages/${pid}/poll/votes`, { answers: [2] });
ok(v.status === 200 && v.data.poll.answers[1].voters.includes(user.user.id), 'голос учтён');
ok((await api(user.token, 'PUT', `/messages/${pid}/poll/votes`, { answers: [1, 2] })).status === 400, 'один вариант — нельзя выбрать два');
v = await api(user.token, 'PUT', `/messages/${pid}/poll/votes`, { answers: [3] });
ok(!v.data.poll.answers[1].voters.includes(user.user.id) && v.data.poll.answers[2].voters.includes(user.user.id), 'переголосовать');
await api(owner.token, 'PUT', `/messages/${pid}/poll/votes`, { answers: [3] });
v = await api(user.token, 'PUT', `/messages/${pid}/poll/votes`, { answers: [] });
ok(v.data.poll.answers[2].voters.length === 1, 'отозвать голос');
ok((await api(user.token, 'PUT', `/messages/${pid}/poll/votes`, { answers: [9] })).status === 400, 'несуществующий вариант — 400');
ok((await api(outsider.token, 'PUT', `/messages/${pid}/poll/votes`, { answers: [1] })).status === 404, 'чужой — 404');
await wait(100);
ok(gwUser.events.some((e) => e.type === 'message_update' && e.message.id === pid && e.message.poll), 'голоса — через message_update');
ok((await api(user.token, 'POST', `/messages/${pid}/poll/end`)).status === 403, 'завершить может только автор');
const ended = await api(owner.token, 'POST', `/messages/${pid}/poll/end`);
ok(ended.status === 200 && ended.data.poll.expires_at <= Date.now() + 1000, 'автор завершил опрос');
ok((await api(user.token, 'PUT', `/messages/${pid}/poll/votes`, { answers: [1] })).status === 400, 'в завершённом опросе не голосуют');
const multi = (await post(owner.token, text.id, { content: 'выбирайте', poll: { question: 'Что берём?', answers: ['Чай', 'Кофе', 'Сок'], multiselect: true } })).data;
v = await api(user.token, 'PUT', `/messages/${multi.id}/poll/votes`, { answers: [1, 3] });
ok(v.status === 200 && v.data.poll.answers[0].voters.length === 1 && v.data.poll.answers[2].voters.length === 1, 'множественный выбор');

// удаление ветки из сообщения — у стартового сообщения ссылка пропадает
await api(owner.token, 'DELETE', `/threads/${th.data.id}`);
const st2 = (await api(owner.token, 'GET', `/channels/${text.id}/messages?around=${starter.id}&limit=1`)).data.find((m) => m.id === starter.id);
ok(st2.thread === null, 'ветка удалена — ссылки у сообщения нет');

gwUser.close();
await api(owner.token, 'DELETE', `/guilds/${g.id}`);
console.log(fails ? `\n${fails} FAIL` : '\nВЕТКИ/ФОРУМЫ/ОПРОСЫ: ВСЕ ПРОВЕРКИ ПРОШЛИ');
process.exit(fails ? 1 : 0);
