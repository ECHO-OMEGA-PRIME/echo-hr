/**
 * Echo HR v1.0.0 — AI-Powered Employee & HR Management System
 * Cloudflare Worker with Hono, D1, KV, service bindings
 */
import { Hono } from 'hono';
import { cors } from 'hono/cors';

interface Env { DB: D1Database; CACHE: KVNamespace; ENGINE_RUNTIME: Fetcher; SHARED_BRAIN: Fetcher; ECHO_API_KEY?: string; }
interface RLState { c: number; t: number }

const app = new Hono<{ Bindings: Env }>();

// Security headers middleware
app.use('*', async (c, next) => {
  await next();
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('X-Frame-Options', 'DENY');
  c.header('X-XSS-Protection', '1; mode=block');
  c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  c.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
});
const ALLOWED_ORIGINS = ['https://echo-ept.com','https://www.echo-ept.com','https://echo-op.com','https://profinishusa.com','https://bgat.echo-op.com'];
app.use('*', cors({ origin: (o) => ALLOWED_ORIGINS.includes(o) ? o : ALLOWED_ORIGINS[0], allowMethods: ['GET','POST','PUT','PATCH','DELETE','OPTIONS'], allowHeaders: ['Content-Type','Authorization','X-Tenant-ID','X-Echo-API-Key'] }));

const uid = () => crypto.randomUUID();
const sanitize = (s: string, max = 5000) => s?.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '').slice(0, max) ?? '';
const sanitizeBody = (o: Record<string, unknown>) => { const r: Record<string, unknown> = {}; for (const [k, v] of Object.entries(o)) r[k] = typeof v === 'string' ? sanitize(v) : v; return r; };
const tid = (c: any) => c.req.header('X-Tenant-ID') || c.req.query('tenant_id') || '';
const json = (d: unknown, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } });

function slog(level: 'info' | 'warn' | 'error', msg: string, data?: Record<string, unknown>) {
  const entry = { ts: new Date().toISOString(), level, worker: 'echo-hr', version: '1.0.0', msg, ...data };
  if (level === 'error') console.error(JSON.stringify(entry));
  else console.log(JSON.stringify(entry));
}

async function rateLimit(kv: KVNamespace, key: string, limit: number, windowSec = 60): Promise<boolean> {
  const rlKey = `rl:${key}`; const now = Date.now();
  const raw = await kv.get(rlKey);
  if (!raw) { await kv.put(rlKey, JSON.stringify({ c: 1, t: now }), { expirationTtl: windowSec * 2 }); return false; }
  const st: RLState = JSON.parse(raw);
  const elapsed = (now - st.t) / 1000;
  const count = Math.max(0, st.c - (elapsed / windowSec) * limit) + 1;
  await kv.put(rlKey, JSON.stringify({ c: count, t: now }), { expirationTtl: windowSec * 2 });
  return count > limit;
}

app.use('*', async (c, next) => {
  const path = new URL(c.req.url).pathname;
  if (path === '/health' || path === '/status') return next();
  const ip = c.req.header('cf-connecting-ip') || 'unknown';
  const isWrite = ['POST','PUT','PATCH','DELETE'].includes(c.req.method);
  if (await rateLimit(c.env.CACHE, `${ip}:${isWrite ? 'w' : 'r'}`, isWrite ? 60 : 200)) return json({ error: 'Rate limited' }, 429);
  return next();
});

// Auth middleware — require API key for write operations
app.use('*', async (c, next) => {
  const method = c.req.method;
  const path = new URL(c.req.url).pathname;
  if (method === 'GET' || method === 'OPTIONS' || method === 'HEAD' || path === '/health' || path === '/status') return next();
  const apiKey = c.req.header('X-Echo-API-Key') || '';
  const bearer = (c.req.header('Authorization') || '').replace('Bearer ', '');
  const expected = c.env.ECHO_API_KEY;
  if (!expected || (apiKey !== expected && bearer !== expected)) {
    return json({ error: 'Unauthorized', message: 'Valid X-Echo-API-Key or Bearer token required for write operations' }, 401);
  }
  return next();
});

app.get('/', (c) => c.json({ service: 'echo-hr', version: '1.0.0', status: 'operational' }));
app.get('/health', (c) => json({ status: 'ok', service: 'echo-hr', version: '1.0.0', time: new Date().toISOString() }));

// ═══════════════ TENANTS ═══════════════
app.post('/tenants', async (c) => {
  const b = sanitizeBody(await c.req.json()); const id = uid();
  await c.env.DB.prepare('INSERT INTO tenants (id,name,email,plan,pay_period,timezone) VALUES (?,?,?,?,?,?)').bind(id, b.name, b.email||null, b.plan||'free', b.pay_period||'biweekly', b.timezone||'America/Chicago').run();
  return json({ id }, 201);
});
app.get('/tenants/:id', async (c) => {
  const r = await c.env.DB.prepare('SELECT * FROM tenants WHERE id=?').bind(c.req.param('id')).first();
  return r ? json(r) : json({ error: 'Not found' }, 404);
});

// ═══════════════ DEPARTMENTS ═══════════════
app.get('/departments', async (c) => {
  return json((await c.env.DB.prepare('SELECT d.*, (SELECT COUNT(*) FROM employees e WHERE e.department_id=d.id AND e.status=\'active\') as employee_count FROM departments d WHERE d.tenant_id=? ORDER BY d.name').bind(tid(c)).all()).results);
});
app.post('/departments', async (c) => {
  const b = sanitizeBody(await c.req.json()); const id = uid();
  await c.env.DB.prepare('INSERT INTO departments (id,tenant_id,name,description,manager_id,parent_id,budget) VALUES (?,?,?,?,?,?,?)').bind(id, tid(c), b.name, b.description||null, b.manager_id||null, b.parent_id||null, b.budget||0).run();
  return json({ id }, 201);
});
app.put('/departments/:id', async (c) => {
  const b = sanitizeBody(await c.req.json());
  await c.env.DB.prepare('UPDATE departments SET name=COALESCE(?,name),description=COALESCE(?,description),manager_id=COALESCE(?,manager_id),parent_id=COALESCE(?,parent_id),budget=COALESCE(?,budget) WHERE id=? AND tenant_id=?').bind(b.name||null, b.description||null, b.manager_id||null, b.parent_id||null, b.budget||null, c.req.param('id'), tid(c)).run();
  return json({ updated: true });
});
app.get('/departments/:id/org-chart', async (c) => {
  const dept = await c.env.DB.prepare('SELECT * FROM departments WHERE id=? AND tenant_id=?').bind(c.req.param('id'), tid(c)).first();
  const employees = (await c.env.DB.prepare('SELECT id,first_name,last_name,title,manager_id,avatar_url FROM employees WHERE department_id=? AND tenant_id=? AND status=\'active\' ORDER BY last_name').bind(c.req.param('id'), tid(c)).all()).results;
  return json({ department: dept, employees });
});

// ═══════════════ EMPLOYEES ═══════════════
app.get('/employees', async (c) => {
  const t = tid(c); const dept = c.req.query('department_id'); const status = c.req.query('status') || 'active'; const search = c.req.query('q');
  let q = 'SELECT e.*, d.name as department_name FROM employees e LEFT JOIN departments d ON e.department_id=d.id WHERE e.tenant_id=?'; const p: unknown[] = [t];
  if (status !== 'all') { q += ' AND e.status=?'; p.push(status); }
  if (dept) { q += ' AND e.department_id=?'; p.push(dept); }
  if (search) { q += ' AND (e.first_name LIKE ? OR e.last_name LIKE ? OR e.email LIKE ?)'; const s = `%${sanitize(search,100)}%`; p.push(s,s,s); }
  q += ' ORDER BY e.last_name, e.first_name'; return json((await c.env.DB.prepare(q).bind(...p).all()).results);
});
app.get('/employees/:id', async (c) => {
  const r = await c.env.DB.prepare('SELECT e.*, d.name as department_name FROM employees e LEFT JOIN departments d ON e.department_id=d.id WHERE e.id=? AND e.tenant_id=?').bind(c.req.param('id'), tid(c)).first();
  return r ? json(r) : json({ error: 'Not found' }, 404);
});
app.post('/employees', async (c) => {
  const b = sanitizeBody(await c.req.json()); const id = uid(); const t = tid(c);
  const count = await c.env.DB.prepare('SELECT COUNT(*) as c FROM employees WHERE tenant_id=? AND status=\'active\'').bind(t).first() as any;
  const tenant = await c.env.DB.prepare('SELECT max_employees FROM tenants WHERE id=?').bind(t).first() as any;
  if (tenant && count && count.c >= tenant.max_employees) return json({ error: 'Employee limit reached' }, 403);
  const num = b.employee_number || `EMP-${Date.now().toString(36).toUpperCase()}`;
  await c.env.DB.prepare('INSERT INTO employees (id,tenant_id,employee_number,first_name,last_name,email,phone,title,department_id,manager_id,employment_type,status,hire_date,salary,pay_rate,pay_type,address,city,state,zip,date_of_birth,emergency_contact_name,emergency_contact_phone,notes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').bind(id, t, num, b.first_name, b.last_name, b.email||null, b.phone||null, b.title||null, b.department_id||null, b.manager_id||null, b.employment_type||'full_time', 'active', b.hire_date||null, b.salary||0, b.pay_rate||0, b.pay_type||'salary', b.address||null, b.city||null, b.state||null, b.zip||null, b.date_of_birth||null, b.emergency_contact_name||null, b.emergency_contact_phone||null, b.notes||null).run();
  return json({ id, employee_number: num }, 201);
});
app.put('/employees/:id', async (c) => {
  const b = sanitizeBody(await c.req.json());
  await c.env.DB.prepare('UPDATE employees SET first_name=COALESCE(?,first_name),last_name=COALESCE(?,last_name),email=COALESCE(?,email),phone=COALESCE(?,phone),title=COALESCE(?,title),department_id=COALESCE(?,department_id),manager_id=COALESCE(?,manager_id),employment_type=COALESCE(?,employment_type),salary=COALESCE(?,salary),pay_rate=COALESCE(?,pay_rate),pay_type=COALESCE(?,pay_type),notes=COALESCE(?,notes),updated_at=datetime(\'now\') WHERE id=? AND tenant_id=?').bind(b.first_name||null, b.last_name||null, b.email||null, b.phone||null, b.title||null, b.department_id||null, b.manager_id||null, b.employment_type||null, b.salary||null, b.pay_rate||null, b.pay_type||null, b.notes||null, c.req.param('id'), tid(c)).run();
  return json({ updated: true });
});
app.post('/employees/:id/terminate', async (c) => {
  const b = sanitizeBody(await c.req.json());
  await c.env.DB.prepare("UPDATE employees SET status='terminated',termination_date=COALESCE(?,datetime('now')),notes=COALESCE(?,notes),updated_at=datetime('now') WHERE id=? AND tenant_id=?").bind(b.termination_date||null, b.reason||null, c.req.param('id'), tid(c)).run();
  return json({ terminated: true });
});
app.get('/employees/:id/direct-reports', async (c) => {
  return json((await c.env.DB.prepare("SELECT id,first_name,last_name,title,email,status FROM employees WHERE manager_id=? AND tenant_id=? AND status='active' ORDER BY last_name").bind(c.req.param('id'), tid(c)).all()).results);
});

// ═══════════════ TIME TRACKING ═══════════════
app.get('/time-entries', async (c) => {
  const t = tid(c); const empId = c.req.query('employee_id'); const from = c.req.query('from'); const to = c.req.query('to');
  let q = 'SELECT t.*, e.first_name, e.last_name FROM time_entries t JOIN employees e ON t.employee_id=e.id WHERE t.tenant_id=?'; const p: unknown[] = [t];
  if (empId) { q += ' AND t.employee_id=?'; p.push(empId); }
  if (from) { q += ' AND t.date>=?'; p.push(from); }
  if (to) { q += ' AND t.date<=?'; p.push(to); }
  q += ' ORDER BY t.date DESC, t.clock_in DESC LIMIT 500'; return json((await c.env.DB.prepare(q).bind(...p).all()).results);
});
app.post('/time-entries', async (c) => {
  const b = sanitizeBody(await c.req.json()); const id = uid();
  let hours = Number(b.hours) || 0;
  if (b.clock_in && b.clock_out) { const diff = (new Date(`2000-01-01T${b.clock_out}`).getTime() - new Date(`2000-01-01T${b.clock_in}`).getTime()) / 3600000; hours = Math.max(0, diff - (Number(b.break_minutes) || 0) / 60); }
  const overtime = Math.max(0, hours - 8);
  await c.env.DB.prepare('INSERT INTO time_entries (id,tenant_id,employee_id,date,clock_in,clock_out,hours,overtime_hours,break_minutes,type,project,notes,status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').bind(id, tid(c), b.employee_id, b.date, b.clock_in||null, b.clock_out||null, hours, overtime, b.break_minutes||0, b.type||'regular', b.project||null, b.notes||null, 'pending').run();
  return json({ id, hours, overtime_hours: overtime }, 201);
});
app.post('/time-entries/:id/approve', async (c) => {
  const b = sanitizeBody(await c.req.json());
  await c.env.DB.prepare("UPDATE time_entries SET status='approved',approved_by=? WHERE id=? AND tenant_id=?").bind(b.approved_by||'system', c.req.param('id'), tid(c)).run();
  return json({ approved: true });
});
app.post('/time-entries/bulk-approve', async (c) => {
  const b = await c.req.json() as { ids: string[]; approved_by?: string };
  const stmt = c.env.DB.prepare("UPDATE time_entries SET status='approved',approved_by=? WHERE id=? AND tenant_id=?");
  await c.env.DB.batch(b.ids.map(id => stmt.bind(b.approved_by||'system', id, tid(c))));
  return json({ approved: b.ids.length });
});

// ═══════════════ LEAVE TYPES ═══════════════
app.get('/leave-types', async (c) => {
  return json((await c.env.DB.prepare('SELECT * FROM leave_types WHERE tenant_id=? ORDER BY name').bind(tid(c)).all()).results);
});
app.post('/leave-types', async (c) => {
  const b = sanitizeBody(await c.req.json()); const id = uid();
  await c.env.DB.prepare('INSERT INTO leave_types (id,tenant_id,name,days_per_year,carry_over,max_carry_over,requires_approval,paid,color) VALUES (?,?,?,?,?,?,?,?,?)').bind(id, tid(c), b.name, b.days_per_year||0, b.carry_over ? 1 : 0, b.max_carry_over||0, b.requires_approval !== false ? 1 : 0, b.paid !== false ? 1 : 0, b.color||'#3b82f6').run();
  return json({ id }, 201);
});

// ═══════════════ LEAVE REQUESTS ═══════════════
app.get('/leave-requests', async (c) => {
  const t = tid(c); const empId = c.req.query('employee_id'); const status = c.req.query('status');
  let q = 'SELECT lr.*, e.first_name, e.last_name, lt.name as leave_type_name, lt.color FROM leave_requests lr JOIN employees e ON lr.employee_id=e.id JOIN leave_types lt ON lr.leave_type_id=lt.id WHERE lr.tenant_id=?'; const p: unknown[] = [t];
  if (empId) { q += ' AND lr.employee_id=?'; p.push(empId); }
  if (status) { q += ' AND lr.status=?'; p.push(status); }
  q += ' ORDER BY lr.start_date DESC LIMIT 200'; return json((await c.env.DB.prepare(q).bind(...p).all()).results);
});
app.post('/leave-requests', async (c) => {
  const b = sanitizeBody(await c.req.json()); const id = uid(); const t = tid(c);
  // Check balance
  const year = new Date(b.start_date as string).getFullYear();
  const bal = await c.env.DB.prepare('SELECT * FROM leave_balances WHERE employee_id=? AND leave_type_id=? AND year=?').bind(b.employee_id, b.leave_type_id, year).first() as any;
  const available = bal ? (bal.entitled + bal.carried_over + bal.adjustment - bal.used) : 0;
  const days = Number(b.days) || 1;
  if (bal && available < days) return json({ error: 'Insufficient leave balance', available }, 400);
  await c.env.DB.prepare('INSERT INTO leave_requests (id,tenant_id,employee_id,leave_type_id,start_date,end_date,days,reason,status) VALUES (?,?,?,?,?,?,?,?,?)').bind(id, t, b.employee_id, b.leave_type_id, b.start_date, b.end_date, days, b.reason||null, 'pending').run();
  return json({ id }, 201);
});
app.post('/leave-requests/:id/approve', async (c) => {
  const b = sanitizeBody(await c.req.json()); const id = c.req.param('id'); const t = tid(c);
  const req = await c.env.DB.prepare('SELECT * FROM leave_requests WHERE id=? AND tenant_id=?').bind(id, t).first() as any;
  if (!req) return json({ error: 'Not found' }, 404);
  // Use conditional UPDATE to prevent race condition — only deduct if sufficient balance
  const year = new Date(req.start_date).getFullYear();
  const results = await c.env.DB.batch([
    c.env.DB.prepare("UPDATE leave_requests SET status='approved',approved_by=?,approved_at=datetime('now') WHERE id=? AND status='pending'").bind(b.approved_by||'system', id),
    c.env.DB.prepare('UPDATE leave_balances SET used=used+? WHERE employee_id=? AND leave_type_id=? AND year=? AND (entitled + carried_over + adjustment - used) >= ?').bind(req.days, req.employee_id, req.leave_type_id, year, req.days),
  ]);
  // Check if balance deduction succeeded (rows affected > 0)
  const balResult = results[1] as D1Result;
  if (!balResult.meta?.changes) {
    // Rollback approval if balance was insufficient
    await c.env.DB.prepare("UPDATE leave_requests SET status='pending',approved_by=NULL,approved_at=NULL WHERE id=?").bind(id).run();
    return json({ error: 'Insufficient leave balance — concurrent approval detected', approved: false }, 409);
  }
  return json({ approved: true });
});
app.post('/leave-requests/:id/reject', async (c) => {
  const b = sanitizeBody(await c.req.json());
  await c.env.DB.prepare("UPDATE leave_requests SET status='rejected',notes=?,approved_by=?,approved_at=datetime('now') WHERE id=? AND tenant_id=?").bind(b.reason||null, b.rejected_by||'system', c.req.param('id'), tid(c)).run();
  return json({ rejected: true });
});
app.get('/leave-balances/:employee_id', async (c) => {
  const year = c.req.query('year') || new Date().getFullYear();
  return json((await c.env.DB.prepare('SELECT lb.*, lt.name as leave_type_name, lt.color, (lb.entitled + lb.carried_over + lb.adjustment - lb.used) as available FROM leave_balances lb JOIN leave_types lt ON lb.leave_type_id=lt.id WHERE lb.employee_id=? AND lb.year=?').bind(c.req.param('employee_id'), year).all()).results);
});
app.post('/leave-balances/initialize', async (c) => {
  const b = await c.req.json() as { employee_id: string; year?: number }; const t = tid(c);
  const year = b.year || new Date().getFullYear();
  const types = (await c.env.DB.prepare('SELECT * FROM leave_types WHERE tenant_id=?').bind(t).all()).results as any[];
  const stmts = types.map(lt => c.env.DB.prepare('INSERT OR IGNORE INTO leave_balances (id,tenant_id,employee_id,leave_type_id,year,entitled) VALUES (?,?,?,?,?,?)').bind(uid(), t, b.employee_id, lt.id, year, lt.days_per_year));
  if (stmts.length) await c.env.DB.batch(stmts);
  return json({ initialized: types.length });
});

// ═══════════════ PAYROLL ═══════════════
app.get('/payroll', async (c) => {
  return json((await c.env.DB.prepare('SELECT * FROM payroll_runs WHERE tenant_id=? ORDER BY period_start DESC LIMIT 50').bind(tid(c)).all()).results);
});
app.post('/payroll/generate', async (c) => {
  const b = sanitizeBody(await c.req.json()); const t = tid(c); const runId = uid();
  const employees = (await c.env.DB.prepare("SELECT * FROM employees WHERE tenant_id=? AND status='active' AND pay_type IS NOT NULL").bind(t).all()).results as any[];
  const timeEntries = (await c.env.DB.prepare("SELECT employee_id, SUM(hours) as total_hours, SUM(overtime_hours) as total_ot FROM time_entries WHERE tenant_id=? AND date>=? AND date<=? AND status='approved' GROUP BY employee_id").bind(t, b.period_start, b.period_end).all()).results as any[];
  const timeMap = new Map(timeEntries.map((te: any) => [te.employee_id, te]));
  let totalGross = 0, totalDeductions = 0, totalNet = 0;
  const items: any[] = [];
  for (const emp of employees) {
    const te = timeMap.get(emp.id) || { total_hours: 0, total_ot: 0 };
    let gross = 0;
    if (emp.pay_type === 'hourly') { gross = (te.total_hours - te.total_ot) * emp.pay_rate + te.total_ot * emp.pay_rate * 1.5; }
    else { gross = emp.salary / (emp.pay_period === 'monthly' ? 12 : emp.pay_period === 'biweekly' ? 26 : 52); }
    const fedTax = gross * 0.22; const stateTax = gross * 0.05; const ss = gross * 0.062; const med = gross * 0.0145;
    const deductions = fedTax + stateTax + ss + med; const net = gross - deductions;
    totalGross += gross; totalDeductions += deductions; totalNet += net;
    items.push({ id: uid(), payroll_run_id: runId, tenant_id: t, employee_id: emp.id, regular_hours: te.total_hours - te.total_ot, overtime_hours: te.total_ot, gross_pay: Math.round(gross * 100) / 100, federal_tax: Math.round(fedTax * 100) / 100, state_tax: Math.round(stateTax * 100) / 100, social_security: Math.round(ss * 100) / 100, medicare: Math.round(med * 100) / 100, other_deductions: 0, net_pay: Math.round(net * 100) / 100 });
  }
  await c.env.DB.prepare('INSERT INTO payroll_runs (id,tenant_id,period_start,period_end,status,total_gross,total_deductions,total_net,employee_count) VALUES (?,?,?,?,?,?,?,?,?)').bind(runId, t, b.period_start, b.period_end, 'draft', Math.round(totalGross * 100) / 100, Math.round(totalDeductions * 100) / 100, Math.round(totalNet * 100) / 100, items.length).run();
  const insertItem = c.env.DB.prepare('INSERT INTO payroll_items (id,payroll_run_id,tenant_id,employee_id,regular_hours,overtime_hours,gross_pay,federal_tax,state_tax,social_security,medicare,other_deductions,net_pay) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)');
  await c.env.DB.batch(items.map(i => insertItem.bind(i.id, i.payroll_run_id, i.tenant_id, i.employee_id, i.regular_hours, i.overtime_hours, i.gross_pay, i.federal_tax, i.state_tax, i.social_security, i.medicare, i.other_deductions, i.net_pay)));
  return json({ payroll_run_id: runId, employee_count: items.length, total_gross: Math.round(totalGross * 100) / 100, total_net: Math.round(totalNet * 100) / 100 }, 201);
});
app.get('/payroll/:id', async (c) => {
  const run = await c.env.DB.prepare('SELECT * FROM payroll_runs WHERE id=? AND tenant_id=?').bind(c.req.param('id'), tid(c)).first();
  const items = (await c.env.DB.prepare('SELECT pi.*, e.first_name, e.last_name, e.employee_number FROM payroll_items pi JOIN employees e ON pi.employee_id=e.id WHERE pi.payroll_run_id=?').bind(c.req.param('id')).all()).results;
  return json({ run, items });
});
app.post('/payroll/:id/approve', async (c) => {
  await c.env.DB.prepare("UPDATE payroll_runs SET status='approved' WHERE id=? AND tenant_id=?").bind(c.req.param('id'), tid(c)).run();
  return json({ approved: true });
});

// ═══════════════ PERFORMANCE REVIEWS ═══════════════
app.get('/reviews', async (c) => {
  const t = tid(c); const empId = c.req.query('employee_id');
  let q = 'SELECT pr.*, e.first_name, e.last_name FROM performance_reviews pr JOIN employees e ON pr.employee_id=e.id WHERE pr.tenant_id=?'; const p: unknown[] = [t];
  if (empId) { q += ' AND pr.employee_id=?'; p.push(empId); }
  q += ' ORDER BY pr.created_at DESC LIMIT 100'; return json((await c.env.DB.prepare(q).bind(...p).all()).results);
});
app.post('/reviews', async (c) => {
  const b = sanitizeBody(await c.req.json()); const id = uid();
  await c.env.DB.prepare('INSERT INTO performance_reviews (id,tenant_id,employee_id,reviewer_id,review_period,overall_rating,ratings_json,strengths,improvements,goals,comments,status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').bind(id, tid(c), b.employee_id, b.reviewer_id||null, b.review_period||null, b.overall_rating||null, typeof b.ratings === 'object' ? JSON.stringify(b.ratings) : b.ratings_json||'{}', b.strengths||null, b.improvements||null, b.goals||null, b.comments||null, 'draft').run();
  return json({ id }, 201);
});
app.post('/reviews/:id/complete', async (c) => {
  await c.env.DB.prepare("UPDATE performance_reviews SET status='completed',completed_at=datetime('now') WHERE id=? AND tenant_id=?").bind(c.req.param('id'), tid(c)).run();
  return json({ completed: true });
});

// ═══════════════ ONBOARDING ═══════════════
app.get('/onboarding/templates', async (c) => {
  return json((await c.env.DB.prepare('SELECT * FROM onboarding_templates WHERE tenant_id=? ORDER BY name').bind(tid(c)).all()).results);
});
app.post('/onboarding/templates', async (c) => {
  const b = sanitizeBody(await c.req.json()); const id = uid();
  await c.env.DB.prepare('INSERT INTO onboarding_templates (id,tenant_id,name,department_id,tasks_json) VALUES (?,?,?,?,?)').bind(id, tid(c), b.name, b.department_id||null, typeof b.tasks === 'object' ? JSON.stringify(b.tasks) : b.tasks_json||'[]').run();
  return json({ id }, 201);
});
app.post('/onboarding/assign', async (c) => {
  const b = sanitizeBody(await c.req.json()); const id = uid();
  const template = await c.env.DB.prepare('SELECT tasks_json FROM onboarding_templates WHERE id=? AND tenant_id=?').bind(b.template_id, tid(c)).first() as any;
  if (!template) return json({ error: 'Template not found' }, 404);
  const tasks = JSON.parse(template.tasks_json);
  const statusMap: Record<string, boolean> = {};
  tasks.forEach((_: any, i: number) => { statusMap[`task_${i}`] = false; });
  await c.env.DB.prepare('INSERT INTO onboarding_progress (id,tenant_id,employee_id,template_id,tasks_status_json) VALUES (?,?,?,?,?)').bind(id, tid(c), b.employee_id, b.template_id, JSON.stringify(statusMap)).run();
  return json({ id }, 201);
});
app.get('/onboarding/:employee_id', async (c) => {
  const progress = (await c.env.DB.prepare('SELECT op.*, ot.name as template_name, ot.tasks_json FROM onboarding_progress op JOIN onboarding_templates ot ON op.template_id=ot.id WHERE op.employee_id=? AND op.tenant_id=?').bind(c.req.param('employee_id'), tid(c)).all()).results;
  return json(progress);
});
app.post('/onboarding/:id/update-task', async (c) => {
  const b = await c.req.json() as { task_key: string; completed: boolean };
  const prog = await c.env.DB.prepare('SELECT tasks_status_json FROM onboarding_progress WHERE id=? AND tenant_id=?').bind(c.req.param('id'), tid(c)).first() as any;
  if (!prog) return json({ error: 'Not found' }, 404);
  const status = JSON.parse(prog.tasks_status_json);
  status[b.task_key] = b.completed;
  const allDone = Object.values(status).every(v => v === true);
  await c.env.DB.prepare("UPDATE onboarding_progress SET tasks_status_json=?,completed_at=? WHERE id=?").bind(JSON.stringify(status), allDone ? new Date().toISOString() : null, c.req.param('id')).run();
  return json({ updated: true, all_complete: allDone });
});

// ═══════════════ DOCUMENTS ═══════════════
app.get('/documents', async (c) => {
  const empId = c.req.query('employee_id');
  let q = 'SELECT * FROM documents WHERE tenant_id=?'; const p: unknown[] = [tid(c)];
  if (empId) { q += ' AND employee_id=?'; p.push(empId); }
  q += ' ORDER BY created_at DESC LIMIT 200'; return json((await c.env.DB.prepare(q).bind(...p).all()).results);
});
app.post('/documents', async (c) => {
  const b = sanitizeBody(await c.req.json()); const id = uid();
  await c.env.DB.prepare('INSERT INTO documents (id,tenant_id,employee_id,name,type,url,expiry_date,notes) VALUES (?,?,?,?,?,?,?,?)').bind(id, tid(c), b.employee_id, b.name, b.type||'general', b.url||null, b.expiry_date||null, b.notes||null).run();
  return json({ id }, 201);
});

// ═══════════════ ANALYTICS ═══════════════
app.get('/analytics/overview', async (c) => {
  const t = tid(c);
  const [empStats, deptCount, pendingLeave, pendingTime] = await Promise.all([
    c.env.DB.prepare("SELECT COUNT(*) as total, COUNT(CASE WHEN status='active' THEN 1 END) as active, COUNT(CASE WHEN hire_date >= date('now','-30 days') THEN 1 END) as new_hires, COUNT(CASE WHEN termination_date >= date('now','-30 days') THEN 1 END) as recent_terminations, AVG(CASE WHEN pay_type='salary' THEN salary END) as avg_salary FROM employees WHERE tenant_id=?").bind(t).first(),
    c.env.DB.prepare('SELECT COUNT(*) as c FROM departments WHERE tenant_id=?').bind(t).first(),
    c.env.DB.prepare("SELECT COUNT(*) as c FROM leave_requests WHERE tenant_id=? AND status='pending'").bind(t).first(),
    c.env.DB.prepare("SELECT COUNT(*) as c FROM time_entries WHERE tenant_id=? AND status='pending'").bind(t).first(),
  ]);
  return json({ employees: empStats, departments: (deptCount as any)?.c || 0, pending_leave_requests: (pendingLeave as any)?.c || 0, pending_time_entries: (pendingTime as any)?.c || 0 });
});
app.get('/analytics/headcount', async (c) => {
  return json((await c.env.DB.prepare("SELECT d.name as department, COUNT(e.id) as headcount, AVG(e.salary) as avg_salary FROM departments d LEFT JOIN employees e ON d.id=e.department_id AND e.status='active' WHERE d.tenant_id=? GROUP BY d.id ORDER BY headcount DESC").bind(tid(c)).all()).results);
});
app.get('/analytics/turnover', async (c) => {
  const t = tid(c); const months = parseInt(c.req.query('months') || '12');
  return json((await c.env.DB.prepare(`SELECT strftime('%Y-%m', termination_date) as month, COUNT(*) as terminations FROM employees WHERE tenant_id=? AND termination_date >= date('now','-${months} months') GROUP BY month ORDER BY month`).bind(t).all()).results);
});
app.get('/analytics/payroll-summary', async (c) => {
  return json((await c.env.DB.prepare("SELECT period_start, period_end, total_gross, total_deductions, total_net, employee_count, status FROM payroll_runs WHERE tenant_id=? ORDER BY period_start DESC LIMIT 12").bind(tid(c)).all()).results);
});

// ═══════════════ AI ═══════════════
app.post('/ai/retention-risk', async (c) => {
  const b = await c.req.json() as { employee_id: string }; const t = tid(c);
  try {
    const emp = await c.env.DB.prepare('SELECT * FROM employees WHERE id=? AND tenant_id=?').bind(b.employee_id, t).first() as any;
    if (!emp) return json({ error: 'Employee not found' }, 404);
    const reviews = (await c.env.DB.prepare('SELECT overall_rating, review_period FROM performance_reviews WHERE employee_id=? ORDER BY created_at DESC LIMIT 3').bind(b.employee_id).all()).results;
    const leave = (await c.env.DB.prepare("SELECT COUNT(*) as c FROM leave_requests WHERE employee_id=? AND created_at >= date('now','-90 days')").bind(b.employee_id).first()) as any;
    const aiRes = await c.env.ENGINE_RUNTIME.fetch('https://engine/query', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ engine_id: 'HR-01', query: `Analyze retention risk for employee: ${emp.first_name} ${emp.last_name}, title: ${emp.title}, tenure: ${emp.hire_date}, salary: $${emp.salary}, recent reviews: ${JSON.stringify(reviews)}, leave requests in 90 days: ${leave?.c}. Provide risk level (low/medium/high) and recommendations.` }) });
    const ai = await aiRes.json() as any;
    return json({ employee: `${emp.first_name} ${emp.last_name}`, analysis: ai.response || ai });
  } catch { return json({ analysis: 'AI unavailable' }); }
});
app.post('/ai/performance-insights', async (c) => {
  const t = tid(c);
  try {
    const stats = await c.env.DB.prepare("SELECT COUNT(*) as total, AVG(overall_rating) as avg_rating, COUNT(CASE WHEN overall_rating >= 4 THEN 1 END) as high_performers, COUNT(CASE WHEN overall_rating < 3 THEN 1 END) as low_performers FROM performance_reviews WHERE tenant_id=? AND status='completed'").bind(t).first();
    const aiRes = await c.env.ENGINE_RUNTIME.fetch('https://engine/query', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ engine_id: 'HR-01', query: `Analyze performance review data: ${JSON.stringify(stats)}. Provide insights on team performance, distribution analysis, and improvement recommendations.` }) });
    const ai = await aiRes.json() as any;
    return json({ stats, insights: ai.response || ai });
  } catch { return json({ insights: 'AI unavailable' }); }
});

// ═══════════════ ACTIVITY LOG ═══════════════
app.get('/activity', async (c) => {
  return json((await c.env.DB.prepare('SELECT * FROM activity_log WHERE tenant_id=? ORDER BY created_at DESC LIMIT 100').bind(tid(c)).all()).results);
});

app.onError((err, c) => {
  if (err.message?.includes('JSON')) {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }
  console.error(`[echo-hr] ${err.message}`);
  return c.json({ error: 'Internal server error' }, 500);
});

app.notFound((c) => {
  return c.json({ error: 'Not found' }, 404);
});

export default {
  fetch: app.fetch,
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    // Daily: check for expiring documents (next 30 days)
    await env.DB.prepare("DELETE FROM activity_log WHERE created_at < datetime('now','-90 days')").run();
    // Clean old time entries older than 2 years
    await env.DB.prepare("DELETE FROM time_entries WHERE date < date('now','-2 years') AND status='approved'").run();
  }
};
