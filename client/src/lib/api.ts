/**
 * API client.
 *
 * One place that knows about CSRF, credentials and error shape. Every call goes
 * through here, so no component can forget the token and no error arrives as an
 * unlabelled string.
 */

export class ApiError extends Error {
  status: number;
  fields?: Record<string, string>;
  constructor(message: string, status: number, fields?: Record<string, string>) {
    super(message);
    this.status = status;
    this.fields = fields;
  }
}

const csrfToken = () =>
  document.cookie.split('; ').find(c => c.startsWith('mgn_csrf='))?.slice('mgn_csrf='.length) ?? '';

type Options = { method?: string; body?: unknown };

export async function api<T = unknown>(path: string, opts: Options = {}): Promise<T> {
  const method = opts.method ?? 'GET';
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) headers['x-csrf-token'] = csrfToken();

  const res = await fetch('/api' + path, {
    method,
    headers,
    credentials: 'same-origin',
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });

  if (res.status === 204) return undefined as T;
  const data = (await res.json().catch(() => ({}))) as { error?: string; fields?: Record<string, string> };
  if (!res.ok) throw new ApiError(data.error ?? `Request failed (${res.status})`, res.status, data.fields);
  return data as T;
}

/** Uploads raw bytes. Metadata rides in headers; see src/platform-routes.js. */
export async function upload(scope: string, scopeId: string, file: File, clientVisible = false) {
  const res = await fetch(
    `/api/documents?${scope}=${encodeURIComponent(scopeId)}&client_visible=${clientVisible}`,
    {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': file.type || 'application/octet-stream',
        'x-filename': file.name,
        'x-csrf-token': csrfToken(),
      },
      body: file,
    },
  );
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new ApiError(data.error ?? 'Upload failed', res.status);
  return data;
}
