// Биты прав — как в src/perms.rs. JS-битовые операции 32-битные, поэтому проверяем делением.
export const P = {
  CREATE_INVITE: 2 ** 0, KICK_MEMBERS: 2 ** 1, BAN_MEMBERS: 2 ** 2, ADMINISTRATOR: 2 ** 3, MANAGE_CHANNELS: 2 ** 4,
  MANAGE_GUILD: 2 ** 5, ADD_REACTIONS: 2 ** 6, VIEW_AUDIT_LOG: 2 ** 7, PRIORITY_SPEAKER: 2 ** 8, STREAM: 2 ** 9,
  VIEW_CHANNEL: 2 ** 10, SEND_MESSAGES: 2 ** 11, MANAGE_MESSAGES: 2 ** 13, EMBED_LINKS: 2 ** 14, ATTACH_FILES: 2 ** 15,
  READ_MESSAGE_HISTORY: 2 ** 16, MENTION_EVERYONE: 2 ** 17, USE_EXTERNAL_EMOJI: 2 ** 18, CONNECT: 2 ** 20, SPEAK: 2 ** 21,
  MUTE_MEMBERS: 2 ** 22, DEAFEN_MEMBERS: 2 ** 23, MOVE_MEMBERS: 2 ** 24, USE_VAD: 2 ** 25, CHANGE_NICKNAME: 2 ** 26,
  MANAGE_NICKNAMES: 2 ** 27, MANAGE_ROLES: 2 ** 28, MANAGE_WEBHOOKS: 2 ** 29, MANAGE_EMOJIS: 2 ** 30,
  MANAGE_THREADS: 2 ** 34, CREATE_THREADS: 2 ** 35, SEND_MESSAGES_IN_THREADS: 2 ** 38, MODERATE_MEMBERS: 2 ** 40,
  PIN_MESSAGES: 2 ** 51,
} as const;
export type PermName = keyof typeof P;

export const has = (perms: number | null | undefined, flag: number) => perms != null && Math.floor(perms / flag) % 2 === 1;
export const withFlag = (perms: number, flag: number, on: boolean) => (has(perms, flag) === on ? perms : on ? perms + flag : perms - flag);

/** Права в ЛС (фиксированные, как DM_PERMS на сервере). */
export const DM_PERMS = P.VIEW_CHANNEL + P.SEND_MESSAGES + P.READ_MESSAGE_HISTORY + P.ADD_REACTIONS + P.ATTACH_FILES + P.EMBED_LINKS + P.PIN_MESSAGES;
