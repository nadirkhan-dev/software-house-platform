import { useEffect, useRef, useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useSession } from '../lib/session';
import { applyTheme, readTheme, type Theme } from '../lib/theme';
import type { Notification, SearchHit } from '../lib/types';
import { dayLabel } from '../lib/format';
import { QuickCreate } from './QuickCreate';
import { NAV_ICONS, SidebarIcon, SunIcon, MoonIcon, SignOutIcon } from './icons';

const NAV = [
  { to: '/', label: 'Dashboard', key: '1' },
  { to: '/leads', label: 'Pipeline', key: '2', sales: true },
  { to: '/quotes', label: 'Quotes', key: '3' },
  { to: '/projects', label: 'Projects', key: '4' },
  { to: '/tasks', label: 'Tasks', key: '5' },
  { to: '/time', label: 'Timesheet', key: '6' },
  { to: '/expenses', label: 'Expenses', key: '7', internal: true },
  { to: '/invoices', label: 'Invoices', key: '8' },
  { to: '/documents', label: 'Documents', key: '9' },
  { to: '/team', label: 'Team', key: '0', revenue: true },
  { to: '/reports', label: 'Reports', revenue: true },
  { to: '/settings', label: 'Settings', revenue: true },
];

const SALES_ROLES = ['admin', 'sales', 'pm'];

export function Shell({ children }: { children: React.ReactNode }) {
  const { user, perms, signOut } = useSession();
  const nav = useNavigate();
  const qc = useQueryClient();
  const [theme, setTheme] = useState<Theme>(readTheme);
  const [collapsed, setCollapsed] = useState(false);
  const [bellOpen, setBellOpen] = useState(false);
  const [userOpen, setUserOpen] = useState(false);
  const [quickOpen, setQuickOpen] = useState(false);
  const [term, setTerm] = useState('');
  const [debounced, setDebounced] = useState('');
  const [sel, setSel] = useState(-1);
  const searchRef = useRef<HTMLInputElement>(null);
  const userWrap = useRef<HTMLDivElement>(null);

  useEffect(() => applyTheme(theme), [theme]);

  // Debounced: a request per keystroke is a request per keystroke.
  useEffect(() => {
    const t = setTimeout(() => setDebounced(term), 200);
    return () => clearTimeout(t);
  }, [term]);

  const { data: results } = useQuery({
    queryKey: ['search', debounced],
    queryFn: () => api<{ results: SearchHit[] }>(`/search?q=${encodeURIComponent(debounced)}`),
    enabled: debounced.trim().length >= 2,
  });

  const { data: notes } = useQuery({
    queryKey: ['notifications'],
    queryFn: () => api<{ notifications: Notification[]; unread: number }>('/notifications'),
    refetchInterval: 60_000,
  });

  // "/" focuses search from anywhere, the way every tool people already use does.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test((e.target as HTMLElement).tagName);
      if (e.key === '/' && !typing) { e.preventDefault(); searchRef.current?.focus(); return; }
      if ((e.key === 'k' || e.key === 'K') && (e.metaKey || e.ctrlKey)) {
        e.preventDefault(); setQuickOpen(true); return;
      }
      if (typing) return;
      const item = NAV.find(n => n.key === e.key);
      if (item) nav(item.to);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [nav]);

  /* The account menu closes on an outside click or Escape rather than on
     mouseleave, the way the notifications panel does: this one holds a theme
     control people adjust and compare, so a menu that vanishes the moment the
     pointer strays is a menu that fights them. Listening on mousedown, not
     click, so it closes on the press instead of waiting for release. */
  useEffect(() => {
    if (!userOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!userWrap.current?.contains(e.target as Node)) setUserOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') setUserOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onEsc);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onEsc);
    };
  }, [userOpen]);

  if (!user || !perms) return null;

  const items = NAV.filter(n =>
    (!n.revenue || perms.seesRevenue) &&
    (!n.internal || !perms.isAssignedOnly) &&
    (!n.sales || SALES_ROLES.includes(user.role)) &&
    (!perms.isClient || ['/', '/projects', '/quotes', '/invoices', '/documents'].includes(n.to)));

  const hits = results?.results ?? [];
  const initials = user.name.split(' ').map(w => w[0]).slice(0, 2).join('');

  const openHit = (h: SearchHit) => {
    setTerm(''); setSel(-1);
    nav(h.link.startsWith('project:') ? `/projects/${h.link.slice(8)}` : `/${h.link.replace(/^\//, '')}`);
  };

  return (
    <div className={`app ${collapsed ? 'collapsed' : ''}`}>
      <aside className="rail">
        <div className="brand">
          <b>Marginly</b><span>v1.0</span>
          <button className="railtoggle" onClick={() => setCollapsed(c => !c)}
            data-tip={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            aria-expanded={!collapsed}>
            <SidebarIcon />
          </button>
        </div>
        <div className="brandrule" />
        <nav className="navgrp">
          <div className="navlbl">{perms.isClient ? 'Client' : 'Operations'}</div>
          {items.map(n => (
            /* data-tip feeds the CSS tooltip shown when the rail is collapsed, and
               aria-label carries the same name for screen readers — the visible
               label is display:none by then, so it leaves the accessibility tree
               with it and the icon alone would announce as an unnamed link. */
            <NavLink key={n.to} to={n.to} end={n.to === '/'} data-tip={n.label} aria-label={n.label}
              className={({ isActive }) => `nav ${isActive ? 'on' : ''}`}>
              {/* No shortcut digit rendered. The keys still work — the handler
                  reads n.key straight off NAV — they are just not on screen. */}
              <span className="ni">{NAV_ICONS[n.to]}</span>
              <span className="nt">{n.label}</span>
            </NavLink>
          ))}
        </nav>
        {/* The rail footer that used to sit here — avatar, name, Sign out — moved
            into the account menu in the top bar. Two places to sign out and two
            places to read your own name is one of each too many. */}
      </aside>

      <div className="main">
        <header className="top">
          <div className="searchbox">
            <input ref={searchRef} value={term} onChange={e => { setTerm(e.target.value); setSel(-1); }}
              onKeyDown={e => {
                if (e.key === 'Escape') { setTerm(''); e.currentTarget.blur(); }
                if (!hits.length) return;
                if (e.key === 'ArrowDown') { e.preventDefault(); setSel(s => (s + 1) % hits.length); }
                if (e.key === 'ArrowUp') { e.preventDefault(); setSel(s => (s - 1 + hits.length) % hits.length); }
                if (e.key === 'Enter') { e.preventDefault(); const h = hits[sel < 0 ? 0 : sel]; if (h) openHit(h); }
              }}
              type="search" placeholder="Search…" aria-label="Search" autoComplete="off" />
            {term.trim().length >= 2 && (
              <div className="results">
                {hits.length ? hits.map((h, i) => (
                  <div key={`${h.type}-${h.id}`} className={`rrow ${i === sel ? 'sel' : ''}`}
                    onMouseDown={() => openHit(h)}>
                    <span className="rt">{h.type}</span>
                    <span className="rl">{h.label}</span>
                    <span className="rh">{h.hint}</span>
                  </div>
                )) : <div className="rrow"><span className="rl" style={{ color: 'var(--muted)' }}>Nothing found</span></div>}
              </div>
            )}
          </div>

          <div className="topspace" />

          {!perms.isClient && (
            <button className="btn pri" onClick={() => setQuickOpen(true)} title="Create anything  ⌘K">
              + Create
            </button>
          )}
          <button className="topbtn" onClick={() => { setBellOpen(o => !o); setUserOpen(false); }}
            aria-label="Notifications">
            ◔{notes?.unread ? <span className="dot-badge">{notes.unread > 9 ? '9+' : notes.unread}</span> : null}
          </button>

          {/* Account menu. Holds what used to be spread between the top bar and
              the rail footer: who you are, the theme switch, and sign out. */}
          <div className="uwrap" ref={userWrap}>
            <button className={`ubtn ${userOpen ? 'on' : ''}`}
              onClick={() => { setUserOpen(o => !o); setBellOpen(false); }}
              aria-label="Account" aria-haspopup="menu" aria-expanded={userOpen}>
              <span className="avatar">{initials}</span>
            </button>
            {userOpen && (
              <div className="umenu" role="menu">
                <div className="uhead">
                  <span className="avatar big">{initials}</span>
                  <div className="uwho">
                    <div className="nm">{user.name}</div>
                    <div className="em">{user.email}</div>
                    <div className="rl">{user.role} · {user.tenant}</div>
                  </div>
                </div>
                <div className="urow">
                  <span className="ulbl">Appearance</span>
                  <div className="seg-toggle">
                    <button className={theme === 'light' ? 'on' : ''}
                      onClick={() => setTheme('light')} aria-pressed={theme === 'light'}>
                      <SunIcon />Light
                    </button>
                    <button className={theme === 'dark' ? 'on' : ''}
                      onClick={() => setTheme('dark')} aria-pressed={theme === 'dark'}>
                      <MoonIcon />Dark
                    </button>
                  </div>
                </div>
                <button className="uitem" role="menuitem"
                  onClick={() => { setUserOpen(false); void signOut(); }}>
                  <SignOutIcon />Sign out
                </button>
              </div>
            )}
          </div>

          {bellOpen && (
            <div className="panel" onMouseLeave={() => setBellOpen(false)}>
              {notes?.notifications.length ? notes.notifications.map(n => (
                <div key={n.id} className={`nrow ${n.read_at ? '' : 'unread'}`}
                  onClick={() => { setBellOpen(false); if (n.link) nav(n.link); }}>
                  {n.title}<time>{dayLabel(n.created_at)}</time>
                </div>
              )) : <div className="empty"><b>Nothing new.</b>Approvals, payments and assignments land here.</div>}
              {!!notes?.unread && (
                <button className="btn tiny" style={{ margin: 10 }}
                  onClick={async () => {
                    await api('/notifications/read', { method: 'POST', body: {} });
                    void qc.invalidateQueries({ queryKey: ['notifications'] });
                  }}>Mark all read</button>
              )}
            </div>
          )}
        </header>

        <main className="view">{children}</main>
      </div>

      {quickOpen && <QuickCreate onClose={() => setQuickOpen(false)} />}
    </div>
  );
}
