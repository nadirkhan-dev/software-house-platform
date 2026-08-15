import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';

type Toast = { id: number; message: string; tone: 'ok' | 'bad' };
const ToastContext = createContext<(m: string, tone?: 'ok' | 'bad') => void>(() => {});

let seq = 0;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);

  const push = useCallback((message: string, tone: 'ok' | 'bad' = 'ok') => {
    const id = ++seq;
    setItems(v => [...v, { id, message, tone }]);
    // Errors linger: if something failed, the person needs time to read why.
    setTimeout(() => setItems(v => v.filter(t => t.id !== id)), tone === 'bad' ? 6000 : 3000);
  }, []);

  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {items.map(t => <div key={t.id} className={`toast ${t.tone === 'bad' ? 'bad' : ''}`}>{t.message}</div>)}
      </div>
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);
