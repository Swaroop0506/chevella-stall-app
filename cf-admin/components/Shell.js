'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { api } from '../lib/api';

const NAV = [
  { href: '/', label: 'Dashboard', icon: '◆' },
  { href: '/events', label: 'Events & QRs', icon: '▣' },
  { href: '/leads', label: 'Leads', icon: '☰', badge: 'needs_review', warn: true },
  { href: '/mobile-setup', label: 'Scanner', icon: '▤' },
];

export default function Shell({ children }) {
  const pathname = usePathname();
  const router = useRouter();
  const [me, setMe] = useState(null);
  const [counts, setCounts] = useState({});

  useEffect(() => {
    let live = true;
    api.get('/auth/me').then((r) => live && setMe(r.admin)).catch(() => {});
    api.get('/stats/overview')
      .then((r) => live && setCounts({ needs_review: r.totals?.needs_review || 0 }))
      .catch(() => {});
    return () => { live = false; };
  }, [pathname]);

  async function logout() {
    try { await api.post('/auth/logout'); } catch { /* sign out locally regardless */ }
    router.replace('/login');
  }

  return (
    <div className="shell">
      <nav className="sidebar no-print">
        <Link href="/" className="brandmark">
          <b>Chevella Farms</b>
          <span>Stall console</span>
        </Link>

        {NAV.map((item) => {
          const active = item.href === '/' ? pathname === '/' : pathname.startsWith(item.href);
          const n = item.badge ? counts[item.badge] : 0;
          return (
            <Link
              key={item.href}
              href={item.href}
              className="navlink"
              data-active={active}
              data-warn={Boolean(item.warn && n)}
            >
              <span aria-hidden="true" style={{ opacity: .7, fontSize: '.8em' }}>{item.icon}</span>
              {item.label}
              {n > 0 && <span className="pill">{n}</span>}
            </Link>
          );
        })}

        <div className="sidebar-foot">
          <div className="who">{me ? me.name : '…'}</div>
          <button type="button" className="btn-sm" onClick={logout}>Sign out</button>
        </div>
      </nav>

      <main className="main">{children}</main>
    </div>
  );
}
