import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api } from './api';
import type { Me, Permissions, User } from './types';

interface Ctx {
  user: User | null;
  perms: Permissions | null;
  loading: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
}

const SessionContext = createContext<Ctx | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [perms, setPerms] = useState<Permissions | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const me = await api<Me>('/me');
      setUser(me.user);
      setPerms(me.permissions);
    } catch {
      setUser(null);
      setPerms(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const signIn = useCallback(async (email: string, password: string) => {
    await api('/login', { method: 'POST', body: { email, password } });
    await load();
  }, [load]);

  const signOut = useCallback(async () => {
    await api('/logout', { method: 'POST' }).catch(() => {});
    setUser(null);
    setPerms(null);
  }, []);

  const value = useMemo(() => ({ user, perms, loading, signIn, signOut }),
    [user, perms, loading, signIn, signOut]);
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession() {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession used outside SessionProvider');
  return ctx;
}
