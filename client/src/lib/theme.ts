/** Theme lives in a cookie rather than localStorage so the server could honour
 *  it during SSR later, and so it survives a hard refresh identically. */

export type Theme = 'light' | 'dark';

export function readTheme(): Theme {
  const saved = document.cookie.split('; ').find(c => c.startsWith('mgn_theme='))?.split('=')[1];
  if (saved === 'dark' || saved === 'light') return saved;
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function applyTheme(t: Theme) {
  document.documentElement.dataset.theme = t;
  document.cookie = `mgn_theme=${t}; path=/; max-age=31536000; samesite=lax`;
}
