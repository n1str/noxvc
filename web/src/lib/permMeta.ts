// Группы прав для редакторов, опасные права и права, имеющие смысл в канале каждого типа.
import { P, type PermName } from './perms';

export const PERM_GROUPS: { key: 'general' | 'members' | 'text' | 'voice' | 'advanced'; perms: PermName[] }[] = [
  { key: 'general', perms: ['VIEW_CHANNEL', 'MANAGE_CHANNELS', 'MANAGE_ROLES', 'MANAGE_GUILD', 'VIEW_AUDIT_LOG', 'MANAGE_EMOJIS', 'MANAGE_WEBHOOKS'] },
  { key: 'members', perms: ['CREATE_INVITE', 'CHANGE_NICKNAME', 'MANAGE_NICKNAMES', 'KICK_MEMBERS', 'BAN_MEMBERS', 'MODERATE_MEMBERS'] },
  { key: 'text', perms: ['SEND_MESSAGES', 'SEND_MESSAGES_IN_THREADS', 'CREATE_THREADS', 'MANAGE_THREADS', 'EMBED_LINKS', 'ATTACH_FILES', 'ADD_REACTIONS', 'USE_EXTERNAL_EMOJI', 'MENTION_EVERYONE', 'MANAGE_MESSAGES', 'PIN_MESSAGES', 'READ_MESSAGE_HISTORY'] },
  { key: 'voice', perms: ['CONNECT', 'SPEAK', 'STREAM', 'USE_VAD', 'PRIORITY_SPEAKER', 'MUTE_MEMBERS', 'DEAFEN_MEMBERS', 'MOVE_MEMBERS'] },
  { key: 'advanced', perms: ['ADMINISTRATOR'] },
];

export const DANGEROUS = new Set<PermName>(['ADMINISTRATOR', 'MANAGE_GUILD', 'MANAGE_ROLES', 'MANAGE_CHANNELS', 'BAN_MEMBERS', 'KICK_MEMBERS', 'MANAGE_MESSAGES', 'MENTION_EVERYONE', 'MODERATE_MEMBERS']);

/** Права, которые бывают в overwrites канала (серверные — только на роли). */
const CHANNEL_COMMON: PermName[] = ['VIEW_CHANNEL', 'MANAGE_CHANNELS', 'MANAGE_ROLES', 'CREATE_INVITE'];
const TEXT: PermName[] = ['SEND_MESSAGES', 'SEND_MESSAGES_IN_THREADS', 'CREATE_THREADS', 'MANAGE_THREADS', 'EMBED_LINKS', 'ATTACH_FILES', 'ADD_REACTIONS', 'USE_EXTERNAL_EMOJI', 'MENTION_EVERYONE', 'MANAGE_MESSAGES', 'PIN_MESSAGES', 'READ_MESSAGE_HISTORY'];
const VOICE: PermName[] = ['CONNECT', 'SPEAK', 'STREAM', 'USE_VAD', 'PRIORITY_SPEAKER', 'MUTE_MEMBERS', 'DEAFEN_MEMBERS', 'MOVE_MEMBERS'];
export function channelPerms(kind: string): PermName[] {
  if (kind === 'voice') return [...CHANNEL_COMMON, ...VOICE];
  if (kind === 'category') return [...CHANNEL_COMMON, ...TEXT, ...VOICE];
  return [...CHANNEL_COMMON, ...TEXT];
}

export const ALL_FLAGS = Object.values(P).reduce((a, b) => a + b, 0);
