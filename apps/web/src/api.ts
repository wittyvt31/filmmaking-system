import type { Validation } from '@filmmaking/web-api/types';

export class RequestError extends Error {
  constructor(
    message: string,
    readonly issues?: Validation['issues'],
  ) {
    super(message);
    this.name = 'RequestError';
  }
}

export async function api<T>(
  path: string,
  payload?: object,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch('/api/' + path, {
    ...(payload
      ? {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        }
      : {}),
    ...(signal ? { signal } : {}),
  });
  const data = (await response.json()) as T & {
    error?: string;
    issues?: Validation['issues'];
  };
  if (!response.ok)
    throw new RequestError(data.error ?? 'Request failed.', data.issues);
  return data;
}
