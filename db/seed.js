import '../src/env.js';   // must be first: src/db.js reads DATABASE_URL at module scope
import bcrypt from 'bcryptjs';
import { asOwner, closePool } from '../src/db.js';

/* Deterministic RNG so the seeded book is the same every run and screenshots,
   tests and demos all agree with each other. */
let s = 20260806;
const rnd = () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296;

const TODAY = new Date();
const d = back => {
  const x = new Date(TODAY); x.setDate(x.getDate() - back);
  return x.toISOString().slice(0, 10);
};

const PASSWORD = 'marginly';
const MONTH_HOURS = 176;
const OVERHEAD = 1.9;

/* ============================================================================
   Two tenants, not one.

   A single-tenant seed cannot demonstrate tenant isolation: every query returns
   the only rows there are, so a broken policy looks exactly like a working one.
   Lahore Labs exists so the suite has something to fail against.
   ============================================================================ */

const TENANTS = [
  {
    id: '11111111-1111-1111-1111-111111111111',
    name: 'KDC Digital', slug: 'kdc', domain: 'kdc.pk', nextInvoiceNo: 169,
    address: 'Suite 402, Ocean Tower, Clifton, Karachi 75600, Pakistan', taxId: 'NTN 4820193-7',
    people: [
      { key:'ayesha', name:'Ayesha Siddiqui', role:'admin',     cost:620000, bill:55, cap:30 },
      { key:'nadia',  name:'Nadia Farooq',    role:'finance',   cost:380000, bill: 0, cap:40 },
      { key:'tariq',  name:'Tariq Mahmood',   role:'sales',     cost:350000, bill: 0, cap:40 },
      { key:'bilal',  name:'Bilal Ahmed',     role:'pm',        cost:410000, bill:45, cap:38 },
      { key:'hina',   name:'Hina Raza',       role:'lead',      cost:480000, bill:50, cap:36 },
      { key:'usman',  name:'Usman Tariq',     role:'developer', cost:310000, bill:38, cap:40 },
      { key:'sana',   name:'Sana Malik',      role:'developer', cost:265000, bill:35, cap:40 },
      { key:'faisal', name:'Faisal Iqbal',    role:'developer', cost:340000, bill:40, cap:40 },
      { key:'imran',  name:'Imran Yousaf',    role:'designer',  cost:295000, bill:36, cap:40 },
      { key:'zara',   name:'Zara Khan',       role:'qa',        cost:195000, bill:28, cap:40 },
      { key:'omar',   name:'Omar Sheikh',     role:'developer', cost:225000, bill:32, cap:20, employment:'contractor' },
    ],
    clients: [
      { key:'northwind',  name:'Northwind Retail',    country:'United States',  ccy:'USD', pay:'wise',
        portal:{ email:'procurement@northwind.example', name:'Dana Whitfield' } },
      { key:'verdal',     name:'Verdal Health',       country:'Germany',        ccy:'USD', pay:'payoneer' },
      { key:'kite',       name:'Kite Logistics',      country:'United Kingdom', ccy:'USD', pay:'wise' },
      { key:'sadiq',      name:'Sadiq Motors',        country:'Pakistan',       ccy:'PKR', pay:'local_transfer' },
      { key:'brightpath', name:'Brightpath Learning', country:'Canada',         ccy:'USD', pay:'wise' },
    ],
    projects: [
      { key:'checkout', client:'northwind',  name:'Checkout replatform', type:'fixed',    value:48000, target:.40, start:118, due: 26, burn:1.08,
        team:['bilal','hina','usman','sana','zara'], ms:[['Discovery',1],['Design system',1],['Cart + checkout',1],['Payments',0],['Launch',0]] },
      { key:'portal',   client:'verdal',     name:'Clinician portal',    type:'fixed',    value:62000, target:.42, start: 96, due:-74, burn:0.36,
        team:['ayesha','bilal','hina','faisal','zara'], ms:[['Architecture',1],['Auth + roles',1],['Records module',0],['Scheduling',0],['Compliance audit',0]] },
      { key:'fleet',    client:'kite',       name:'Fleet tracking app',  type:'hourly',   value:26000, target:.38, start: 74, due:-40, burn:0.54,
        team:['usman','faisal','omar'], ms:[['Spec',1],['iOS build',1],['Android build',0],['Handover',0]] },
      { key:'lms',      client:'brightpath', name:'LMS retainer',        type:'retainer', value:30000, target:.45, start:150, due:-62, burn:0.71,
        team:['hina','sana','zara'], ms:[['Q1 sprint',1],['Q2 sprint',1],['Q3 sprint',0],['Q4 sprint',0]] },
      { key:'dealer',   client:'sadiq',      name:'Dealer dashboard',    type:'fixed',    value:11000, target:.35, start: 52, due: 18, burn:0.94,
        team:['sana','omar','imran'], ms:[['Wireframes',1],['Build',1],['UAT',0]] },
      { key:'search',   client:'northwind',  name:'Search relevance',    type:'hourly',   value:16000, target:.40, start: 30, due:-55, burn:0.29,
        team:['faisal','usman'], ms:[['Indexing',1],['Ranking',0],['Tuning',0]] },
    ],
    changeOrders: [
      { p:'checkout', title:'Add Apple Pay + Google Pay', hrs:64, price:3200, status:'approved', raised:41 },
      { p:'checkout', title:'Third-party loyalty sync',   hrs:96, price:0,    status:'absorbed', raised:22 },
      { p:'portal',   title:'HIPAA audit trail export',   hrs:40, price:2400, status:'sent',     raised: 6 },
      { p:'dealer',   title:'Urdu localisation',          hrs:52, price:0,    status:'absorbed', raised:19 },
    ],
    leads: [
      { company:'Halcyon Freight',  contact:'Marta Reyes',  email:'marta@halcyon.example',  source:'referral',    value: 72000, prob:70, stage:'negotiation', follow: -3 },
      { company:'Blue Harbour Co',  contact:'Tom Alderman', email:'tom@blueharbour.example', source:'inbound',     value: 28000, prob:40, stage:'proposal',    follow: -6 },
      { company:'Meritas Legal',    contact:'Rachel Kwan',  email:'rachel@meritas.example',  source:'outbound',    value: 45000, prob:25, stage:'qualified',   follow: -1 },
      { company:'Orbit Fitness',    contact:'Danny Cole',   email:'danny@orbitfit.example',  source:'marketplace', value: 15000, prob:10, stage:'new',         follow:-10 },
      { company:'Pinewood Studios', contact:'Alia Rahman',  email:'alia@pinewood.example',   source:'event',       value: 33000, prob: 0, stage:'lost',        follow: null, lost:'Went with an in-house team' },
    ],
    quotes: [
      { key:'halcyon', client:'northwind', title:'Warehouse portal — phase one', status:'sent', expires:-21, terms:'50% on acceptance, 50% on delivery',
        lines:[['Discovery and technical design',1,8000],['Portal build',1,26000],['Integration and UAT',1,9000]] },
      { key:'verdal2', client:'verdal', title:'Scheduling module', status:'draft', expires:-30, terms:'Monthly in arrears',
        lines:[['Scheduling engine',1,18000],['Calendar sync',1,7000]] },
    ],
    tasks: [
      { p:'checkout', title:'Wire Apple Pay into checkout flow',     who:'usman',  status:'doing',   pri:'high',   est:16, due: -3 },
      { p:'checkout', title:'Fix cart totals rounding on discounts', who:'sana',   status:'review',  pri:'urgent', est: 6, due: -1 },
      { p:'checkout', title:'Regression pass on payment failures',   who:'zara',   status:'todo',    pri:'high',   est:12, due: -6 },
      { p:'checkout', title:'Launch runbook',                        who:'bilal',  status:'backlog', pri:'medium', est: 4, due:-14 },
      { p:'portal',   title:'Records module data mapping',           who:'faisal', status:'doing',   pri:'high',   est:24, due: -8 },
      { p:'portal',   title:'Role matrix sign-off with compliance',  who:'hina',   status:'todo',    pri:'medium', est: 8, due:-12 },
      { p:'dealer',   title:'UAT feedback from Sadiq Motors',        who:'sana',   status:'review',  pri:'high',   est: 5, due: -2 },
      { p:'fleet',    title:'Android background location handling',  who:'omar',   status:'doing',   pri:'urgent', est:20, due: -5 },
      { p:'lms',      title:'Q3 sprint planning',                    who:'hina',   status:'todo',    pri:'low',    est: 3, due: -9 },
      { p:'search',   title:'Ranking model evaluation harness',      who:'faisal', status:'done',    pri:'medium', est:10, due:  4 },
    ],
    payments: [
      { inv:'INV-0141', amount: 19200, method:'wise',     ref:'WISE-88213', days: 63 },
      { inv:'INV-0148', amount:  9600, method:'wise',     ref:'WISE-90114', days: 21 },
      { inv:'INV-0155', amount: 12400, method:'payoneer', ref:'PAY-44120',  days: 37 },
      { inv:'INV-0163', amount:  4000, method:'bank_transfer', ref:'HBL-77219', days: 5 },
    ],
    expenses: [
      { p:'checkout', desc:'Cloud hosting — staging + prod', cat:'infrastructure', amt:1840, days:40 },
      { p:'checkout', desc:'Payment gateway certification',  cat:'services',       amt: 950, days:28 },
      { p:'portal',   desc:'Penetration test',               cat:'services',       amt:2400, days:18 },
      { p:'lms',      desc:'Design tooling seats',           cat:'software',       amt: 420, days:12 },
    ],
    invoices: [
      { n:'INV-0141', p:'checkout', ms:[0,1], issued: 96, due: 66, status:'paid', via:'wise' },
      { n:'INV-0148', p:'checkout', ms:[2],   issued: 54, due: 24, status:'paid', via:'wise' },
      { n:'INV-0155', p:'portal',   ms:[0],   issued: 70, due: 40, status:'paid', via:'payoneer' },
      { n:'INV-0161', p:'portal',   ms:[1],   issued: 34, due:  4, status:'sent', via:'payoneer' },
      { n:'INV-0163', p:'lms',      ms:[0],   issued: 28, due: -2, status:'sent', via:'wise' },
      { n:'INV-0166', p:'dealer',   ms:[0],   issued: 21, due: -9, status:'sent', via:'local_transfer' },
      { n:'INV-0168', p:'fleet',    hourlyUpTo: 30, issued: 12, due:-18, status:'sent', via:'wise' },
    ],
  },
  {
    id: '22222222-2222-2222-2222-222222222222',
    name: 'Lahore Labs', slug: 'lahorelabs', domain: 'lahorelabs.pk', nextInvoiceNo: 25,
    address: '11-C Gulberg III, Lahore 54660, Pakistan', taxId: 'NTN 7391028-4',
    people: [
      { key:'rehan',   name:'Rehan Aslam',  role:'admin',     cost:540000, bill:50, cap:35 },
      { key:'mehwish', name:'Mehwish Butt', role:'pm',        cost:390000, bill:44, cap:40 },
      { key:'kamran',  name:'Kamran Shah',  role:'developer', cost:280000, bill:36, cap:40 },
      { key:'areeba',  name:'Areeba Nasir', role:'developer', cost:250000, bill:34, cap:40 },
    ],
    clients: [
      { key:'acme',     name:'Acme Industrial', country:'United States', ccy:'USD', pay:'wise',
        portal:{ email:'ap@acme.example', name:'Grant Holloway' } },
      { key:'meridian', name:'Meridian Bank',   country:'Singapore',     ccy:'USD', pay:'bank_wire' },
    ],
    projects: [
      { key:'inventory',  client:'acme',     name:'Inventory sync', type:'fixed',  value:34000, target:.40, start:60, due:-30, burn:0.62,
        team:['mehwish','kamran','areeba'], ms:[['Discovery',1],['Integration',1],['Rollout',0]] },
      { key:'onboarding', client:'meridian', name:'KYC onboarding', type:'hourly', value:41000, target:.42, start:45, due:-70, burn:0.48,
        team:['rehan','kamran'], ms:[['Scoping',1],['Document capture',0],['Compliance sign-off',0]] },
    ],
    changeOrders: [
      { p:'inventory', title:'Extra warehouse region', hrs:38, price:1900, status:'approved', raised:12 },
    ],
    leads: [
      { company:'Cedar Point Retail', contact:'Ana Duarte', email:'ana@cedarpoint.example', source:'inbound', value: 40000, prob:55, stage:'proposal', follow:-4 },
      { company:'Vantage Logistics',  contact:'Ravi Menon', email:'ravi@vantage.example',   source:'referral', value: 26000, prob:30, stage:'qualified', follow:-8 },
    ],
    quotes: [
      { key:'cedar', client:'acme', title:'Stock reconciliation service', status:'sent', expires:-14, terms:'Net 30',
        lines:[['Discovery',1,6000],['Build and rollout',1,21000]] },
    ],
    tasks: [
      { p:'inventory',  title:'Warehouse region mapping', who:'kamran', status:'doing', pri:'high',   est:12, due:-4 },
      { p:'inventory',  title:'EDI acceptance tests',     who:'areeba', status:'todo',  pri:'medium', est: 8, due:-9 },
      { p:'onboarding', title:'Document capture spike',   who:'kamran', status:'todo',  pri:'high',   est:16, due:-6 },
    ],
    payments: [
      { inv:'LL-0021', amount: 11333.33, method:'wise', ref:'WISE-51002', days: 11 },
    ],
    expenses: [
      { p:'inventory', desc:'EDI connector licence', cat:'software', amt:1250, days:22 },
    ],
    invoices: [
      { n:'LL-0021', p:'inventory',  ms:[0], issued:44, due: 14, status:'paid', via:'wise' },
      { n:'LL-0024', p:'onboarding', hourlyUpTo:20, issued:14, due:-16, status:'sent', via:'bank_wire' },
    ],
  },
];

async function seedTenant(c, T, hash) {
  await c.query(
    `INSERT INTO tenants (id,name,slug,home_currency,base_currency,plan,seats_included,next_invoice_no,
                          legal_name,address,tax_id,email,payment_terms_days,payment_instructions)
     VALUES ($1,$2,$3,'PKR','USD','studio',$4,$5,$6,$7,$8,$9,30,$10)`,
    [T.id, T.name, T.slug, T.people.length + 5, T.nextInvoiceNo,
     `${T.name} (Private) Limited`, T.address, T.taxId, `billing@${T.domain}`,
     'Bank transfer or Wise. Please quote the invoice number as the payment reference.']);

  /* ---- people ---- */
  const uid = {};
  for (const p of T.people) {
    const { rows } = await c.query(
      `INSERT INTO users (email,full_name,password_hash) VALUES ($1,$2,$3) RETURNING id`,
      [`${p.key}@${T.domain}`, p.name, hash]);
    uid[p.key] = rows[0].id;
    await c.query(
      `INSERT INTO memberships (tenant_id,user_id,role,employment,weekly_hours)
       VALUES ($1,$2,$3,$4,$5)`,
      [T.id, uid[p.key], p.role, p.employment || 'full_time', p.cap]);
    await c.query(
      `INSERT INTO rate_cards (tenant_id,user_id,cost_amount,cost_currency,cost_period,
                               overhead_multiplier,bill_rate,bill_currency,valid_from)
       VALUES ($1,$2,$3,'PKR','month',$4,$5,'USD',$6)`,
      [T.id, uid[p.key], p.cost, OVERHEAD, p.bill || 0, d(400)]);
  }

  /* ---- clients, plus a portal login for those that have one ---- */
  const cid = {}, portalUid = {};
  for (const cl of T.clients) {
    const { rows } = await c.query(
      `INSERT INTO clients (tenant_id,name,country,currency,pay_method)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [T.id, cl.name, cl.country, cl.ccy, cl.pay]);
    cid[cl.key] = rows[0].id;
    if (cl.portal) {
      const { rows: u } = await c.query(
        `INSERT INTO users (email,full_name,password_hash) VALUES ($1,$2,$3) RETURNING id`,
        [cl.portal.email, cl.portal.name, hash]);
      portalUid[cl.key] = u[0].id;
      await c.query(
        `INSERT INTO memberships (tenant_id,user_id,role,weekly_hours,client_id)
         VALUES ($1,$2,'client',0,$3)`, [T.id, u[0].id, cid[cl.key]]);
    }
  }
  const anyPortal = Object.values(portalUid)[0] || null;

  /* ---- projects, members, milestones ---- */
  const pid = {};
  for (const p of T.projects) {
    const { rows } = await c.query(
      `INSERT INTO projects (tenant_id,client_id,name,billing_type,contract_value,currency,
                             target_margin,starts_on,due_on,status)
       VALUES ($1,$2,$3,$4,$5,'USD',$6,$7,$8,'active') RETURNING id`,
      [T.id, cid[p.client], p.name, p.type, p.value, p.target, d(p.start), d(p.due)]);
    pid[p.key] = rows[0].id;

    for (const k of p.team)
      await c.query(`INSERT INTO project_members (tenant_id,project_id,user_id,project_role)
                     VALUES ($1,$2,$3,$4)`,
        [T.id, pid[p.key], uid[k], k === p.team[0] ? 'lead' : 'member']);

    let i = 0;
    for (const [name, done] of p.ms) {
      await c.query(
        `INSERT INTO milestones (tenant_id,project_id,name,position,value_amount,approved_at,approved_by,approved_ip)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [T.id, pid[p.key], name, i, +(p.value / p.ms.length).toFixed(2),
         done ? new Date(Date.now() - (p.start - i * 12) * 86400000) : null,
         done ? (portalUid[p.client] || anyPortal) : null,
         done ? '203.0.113.7' : null]);
      i++;
    }
  }

  /* ---- time entries ----
     One row at a time on purpose: the insert trigger resolves the rate card and
     FX rate for each date, and that behaviour is what the product rests on.
     Seeding around it would seed a lie. */
  for (const p of T.projects) {
    const draft = [];
    for (let day = p.start; day >= 0; day--) {
      const dow = new Date(d(day)).getDay();
      if (dow === 0 || dow === 6) continue;
      for (const k of p.team) {
        if (rnd() > 0.74) continue;
        draft.push({ k, day, h: 3 + rnd() * 5 });
      }
    }
    const raw = draft.reduce((sum, e) => {
      const per = T.people.find(x => x.key === e.k);
      return sum + e.h * (per.cost * OVERHEAD / MONTH_HOURS) / 279;
    }, 0);
    const scale = raw > 0 ? (p.value * (1 - p.target) * p.burn) / raw : 1;

    const rows = [];
    for (const e of draft) {
      const h = +(e.h * scale).toFixed(1);
      if (h >= 0.5) rows.push([T.id, pid[p.key], uid[e.k], d(e.day), h, rnd() > 0.16]);
    }
    const CHUNK = 120;
    for (let i = 0; i < rows.length; i += CHUNK) {
      const slice = rows.slice(i, i + CHUNK);
      const ph = slice.map((_, j) =>
        `($${j*6+1},$${j*6+2},$${j*6+3},$${j*6+4},$${j*6+5},$${j*6+6},'delivery')`).join(',');
      await c.query(
        `INSERT INTO time_entries (tenant_id,project_id,user_id,worked_on,hours,billable,category)
         VALUES ${ph}`, slice.flat());
    }
  }

  /* ---- change orders ---- */
  for (const co of T.changeOrders)
    await c.query(
      `INSERT INTO change_orders (tenant_id,project_id,title,est_hours,price_amount,status,created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [T.id, pid[co.p], co.title, co.hrs, co.price, co.status,
       new Date(Date.now() - co.raised * 86400000)]);

  /* ---- expenses: real cost, and project_margin already accounts for it ----
     fx_rate is 1 because these are USD costs in a USD-reporting tenant; the
     column means "units of `currency` per one base unit", same as time. */
  for (const e of T.expenses)
    await c.query(
      `INSERT INTO expenses (tenant_id,project_id,incurred_on,description,category,amount,
                             currency,fx_rate,billable,status,approved_at,approved_by)
       VALUES ($1,$2,$3,$4,$5,$6,'USD',1,false,'approved',now(),$7)`,
      [T.id, pid[e.p], d(e.days), e.desc, e.cat, e.amt, uid[T.people[0].key]]);

  /* ---- tasks ---- */
  const tid = {};
  for (const t of T.tasks || []) {
    const { rows } = await c.query(`
      INSERT INTO tasks (tenant_id, project_id, title, assignee_id, reporter_id, status, priority,
                         estimate_hours, due_on, position)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,
              COALESCE((SELECT max(position)+1 FROM tasks WHERE project_id=$2 AND status=$6),0))
      RETURNING id`,
      [T.id, pid[t.p], t.title, uid[t.who], uid[T.people[0].key], t.status, t.pri,
       t.est, d(t.due)]);
    tid[t.title] = rows[0].id;
    if (t.status === 'done') await c.query('UPDATE tasks SET completed_at = now() WHERE id=$1', [rows[0].id]);
  }

  /* ---- leads ---- */
  for (const l of T.leads || [])
    await c.query(`
      INSERT INTO leads (tenant_id, company, contact_name, email, source, est_value, probability,
                         stage, owner_id, next_follow_up, lost_reason)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [T.id, l.company, l.contact, l.email, l.source, l.value, l.prob, l.stage,
       uid[T.people.find(p => p.role === 'sales')?.key || T.people[0].key],
       l.follow == null ? null : d(l.follow), l.lost || null]);

  /* ---- quotes: totals derived from the lines, never typed ---- */
  for (const q of T.quotes || []) {
    const subtotal = q.lines.reduce((s2, [, qty, unit]) => s2 + qty * unit, 0);
    const { rows } = await c.query(`
      INSERT INTO quotes (tenant_id, client_id, number, title, currency, subtotal, tax_rate,
                          tax_amount, total, payment_terms, expires_on, status, sent_at, created_by)
      VALUES ($1,$2,$3,$4,'USD',$5,0,0,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [T.id, cid[q.client], 'Q-' + String(T.nextInvoiceNo + Object.keys(cid).length).padStart(4, '0') + '-' + q.key.slice(0, 3).toUpperCase(),
       q.title, subtotal, q.terms, d(q.expires), q.status,
       q.status === 'sent' ? new Date(Date.now() - 6 * 86400000) : null, uid[T.people[0].key]]);
    let i = 0;
    for (const [desc, qty, unit] of q.lines)
      await c.query(`
        INSERT INTO quote_lines (tenant_id, quote_id, position, description, quantity, unit_amount)
        VALUES ($1,$2,$3,$4,$5,$6)`, [T.id, rows[0].id, i++, desc, qty, unit]);
  }

  /* ---- invoices: lines point at what they billed, and claim their time ---- */
  for (const inv of T.invoices) {
    const proj = T.projects.find(p => p.key === inv.p);
    let lines = [];
    if (inv.ms) {
      const { rows: ms } = await c.query(
        `SELECT id, name, value_amount FROM milestones WHERE project_id=$1 ORDER BY position`, [pid[inv.p]]);
      lines = inv.ms.map(i => ({
        milestone_id: ms[i].id,
        description: `${proj.name} — ${ms[i].name}`,
        quantity: 1, unit: +ms[i].value_amount,
      }));
    } else {
      const { rows } = await c.query(`
        SELECT u.full_name, sum(te.hours) hours, sum(te.value_base) amount
          FROM time_entries te JOIN users u ON u.id = te.user_id
         WHERE te.project_id = $1 AND te.billable AND te.invoice_id IS NULL
           AND te.worked_on <= $2::date
         GROUP BY u.full_name ORDER BY amount DESC`, [pid[inv.p], d(inv.hourlyUpTo)]);
      lines = rows.map(r => ({
        description: `${r.full_name} — ${(+r.hours).toFixed(1)} hours`,
        quantity: +(+r.hours).toFixed(2), unit: +(r.amount / r.hours).toFixed(2),
      }));
    }
    const total = +lines.reduce((t, l) => t + l.quantity * l.unit, 0).toFixed(2);

    const { rows } = await c.query(
      `INSERT INTO invoices (tenant_id,client_id,project_id,number,issued_on,due_on,currency,
                             subtotal,total,status)
       VALUES ($1,$2,$3,$4,$5,$6,'USD',$7,$7,$8) RETURNING id`,
      [T.id, cid[proj.client], pid[inv.p], inv.n, d(inv.issued), d(inv.due),
       total, inv.status === 'paid' ? 'sent' : inv.status]);
    const invoiceId = rows[0].id;

    for (const l of lines)
      await c.query(
        `INSERT INTO invoice_lines (tenant_id,invoice_id,milestone_id,description,quantity,unit_amount)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [T.id, invoiceId, l.milestone_id || null, l.description, l.quantity, l.unit]);

    await c.query(`
      UPDATE time_entries SET invoice_id = $1, locked_at = now()
       WHERE project_id = $2 AND invoice_id IS NULL AND billable AND worked_on <= $3::date`,
      [invoiceId, pid[inv.p], d(inv.ms ? inv.issued : inv.hourlyUpTo)]);
  }

  /* ---- documents ----
     Written through the real storage driver, so the download endpoint has
     actual bytes to serve rather than a dangling row. */
  const { driver, makeKey, checksum } = await import('../src/storage.js');
  const docs = [
    { scope:'project_id', key:T.projects[0].key, name:'Statement of work.pdf', type:'application/pdf', visible:true },
    { scope:'project_id', key:T.projects[0].key, name:'Architecture notes.md', type:'text/markdown', visible:false },
    { scope:'client_id',  client:T.clients[0].key, name:'Master services agreement.pdf', type:'application/pdf', visible:true },
  ];
  for (const doc of docs) {
    const body = Buffer.from(
      `${doc.name}\n\nSeeded demo document for ${T.name}.\nNot a real contract.\n`, 'utf8');
    const path = makeKey(T.id, doc.name);
    await driver.put(path, body);
    await c.query(`
      INSERT INTO documents (tenant_id, ${doc.scope}, filename, content_type, byte_size,
                             storage_path, checksum, client_visible, uploaded_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [T.id, doc.scope === 'project_id' ? pid[doc.key] : cid[doc.client],
       doc.name, doc.type, body.length, path, checksum(body), doc.visible, uid[T.people[0].key]]);
  }

  /* ---- payments ----
     Invoice status is NOT set here. The rollup trigger derives it from these
     rows, which is the only way an invoice is allowed to become paid. Note
     INV-0163 is deliberately part-paid, so the demo shows a real balance. */
  for (const p of T.payments || []) {
    const { rows } = await c.query(
      'SELECT id, currency FROM invoices WHERE tenant_id=$1 AND number=$2', [T.id, p.inv]);
    if (!rows[0]) continue;
    await c.query(`
      INSERT INTO payments (tenant_id, invoice_id, amount, currency, received_on, method, reference, recorded_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [T.id, rows[0].id, p.amount, rows[0].currency, d(p.days), p.method, p.ref,
       uid[T.people.find(x => x.role === 'finance')?.key || T.people[0].key]]);
  }
}

async function seed() {
  const hash = await bcrypt.hash(PASSWORD, 10);

  const existing = await asOwner(c => c.query('SELECT count(*)::int n FROM tenants'));
  if (existing.rows[0].n > 0) {
    console.error('This database already has data. Run `npm run reset` to rebuild it from scratch.');
    await closePool();
    process.exit(1);
  }

  await asOwner(async c => {
    await c.query('BEGIN');
    // ~2,000 seed rows through the audit trigger is noise, not history. The
    // freeze trigger stays on — it is the point.
    await c.query('ALTER TABLE time_entries DISABLE TRIGGER trg_audit');

    /* FX: 200 days of a sliding rupee, shared by both tenants. */
    let rate = 271.2; const fx = [];
    for (let i = 200; i >= 0; i--) { rate += (rnd() - 0.42) * 0.9; fx.push([d(i), +rate.toFixed(4)]); }
    fx[fx.length - 1][1] = 284.60;
    await c.query(
      `INSERT INTO fx_rates (home_ccy,base_ccy,effective_date,units_per_base,source)
       SELECT 'PKR','USD',x.d::date,x.r::numeric,'seed' FROM unnest($1::text[],$2::numeric[]) AS x(d,r)`,
      [fx.map(f => f[0]), fx.map(f => f[1])]);

    for (const T of TENANTS) await seedTenant(c, T, hash);

    /* Platform staff: no membership, so no tenant context, so no tenant data. */
    await c.query(
      `INSERT INTO users (email,full_name,password_hash,is_platform_admin)
       VALUES ('ops@marginly.app','Platform Operations',$1,true)`, [hash]);

    await c.query('ALTER TABLE time_entries ENABLE TRIGGER trg_audit');
    await c.query('COMMIT');
  });

  const { rows } = await asOwner(c => c.query(`
    SELECT (SELECT count(*) FROM tenants) tenants, (SELECT count(*) FROM projects) projects,
           (SELECT count(*) FROM time_entries) entries, (SELECT round(sum(hours)) FROM time_entries) hours,
           (SELECT count(*) FROM users) users, (SELECT count(*) FROM expenses) expenses,
           (SELECT count(*) FROM tasks) tasks, (SELECT count(*) FROM leads) leads,
           (SELECT count(*) FROM quotes) quotes, (SELECT count(*) FROM payments) payments,
           (SELECT count(*) FROM documents) documents`));
  const r = rows[0];
  console.log(`Seeded ${r.tenants} tenants · ${r.users} users · ${r.projects} projects · ${r.tasks} tasks`);
  console.log(`        ${r.entries} time entries (${r.hours}h) · ${r.expenses} expenses · ${r.leads} leads ` +
              `· ${r.quotes} quotes · ${r.payments} payments · ${r.documents} documents`);
  console.log(`\nSign in with any of these — password "${PASSWORD}":\n`);
  console.log('  KDC Digital');
  console.log('    ayesha@kdc.pk                  admin      everything');
  console.log('    nadia@kdc.pk                   finance    money, invoicing');
  console.log('    bilal@kdc.pk                   pm         delivery + revenue, no salaries');
  console.log('    sana@kdc.pk                    developer  her own work only, no money');
  console.log('    procurement@northwind.example  client     Northwind only');
  console.log('\n  Lahore Labs  (second agency — must never see the above)');
  console.log('    rehan@lahorelabs.pk            admin      everything, in their tenant');
  console.log('    ap@acme.example                client     Acme only');
  console.log('\n  Platform');
  console.log('    ops@marginly.app               platform   provisioning only, no company data');
  await closePool();
}

seed().catch(e => { console.error(e); process.exit(1); });
