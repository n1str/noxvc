// REST-клиент /api. Ошибки сервера приходят как {error: "текст"}.
export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

import { dinvoke, isDesktop, type AppInfo } from './desktop';

let token: string | null = null;
/** Кто входит (список сеансов): веб или приложение и его версия. */
const client: Promise<string> = isDesktop ? dinvoke<AppInfo>('app_info').then((i) => (i?.version ? `desktop/${i.version}` : 'desktop'), () => 'desktop') : Promise.resolve('web');
let onUnauthorized: (() => void) | null = null;

export function setToken(t: string | null) { token = t; }
export function setUnauthorizedHandler(fn: () => void) { onUnauthorized = fn; }

export async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (path === '/login' || path === '/register') headers['X-Relay-Client'] = await client;
  let payload: BodyInit | undefined;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const r = await fetch('/api' + path, { method, headers, body: payload });
  const data = await r.json().catch(() => ({}));
  if (r.status === 401 && token && path !== '/login') onUnauthorized?.();
  if (!r.ok) throw new ApiError(r.status, (data as { error?: string }).error || `Ошибка ${r.status}`);
  return data as T;
}

/** Загрузка файла с прогрессом (fetch не умеет onprogress для отправки). */
export function uploadFile(file: File, onProgress: (p: number) => void): { promise: Promise<{ url: string; name: string; size: number; content_type: string }>; abort(): void } {
  const xhr = new XMLHttpRequest();
  const promise = new Promise<{ url: string; name: string; size: number; content_type: string }>((resolve, reject) => {
    xhr.open('POST', '/api/upload');
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
    xhr.onload = () => {
      let data: { error?: string } = {};
      try { data = JSON.parse(xhr.responseText); } catch { /* не JSON */ }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data as never);
      else reject(new ApiError(xhr.status, data.error || `Ошибка ${xhr.status}`));
    };
    xhr.onerror = () => reject(new ApiError(0, 'Сеть недоступна'));
    xhr.onabort = () => reject(new ApiError(0, 'Загрузка отменена'));
    const fd = new FormData();
    fd.append('file', file, file.name || 'image.png');
    xhr.send(fd);
  });
  return { promise, abort: () => xhr.abort() };
}
