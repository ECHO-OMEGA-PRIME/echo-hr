-- Echo HR v1.0.0 Schema
-- AI-powered employee & HR management system

CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT,
  plan TEXT DEFAULT 'free',
  max_employees INTEGER DEFAULT 10,
  pay_period TEXT DEFAULT 'biweekly',
  timezone TEXT DEFAULT 'America/Chicago',
  fiscal_year_start INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS departments (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  manager_id TEXT,
  parent_id TEXT,
  budget REAL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);
CREATE INDEX IF NOT EXISTS idx_dept_tenant ON departments(tenant_id);

CREATE TABLE IF NOT EXISTS employees (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  employee_number TEXT,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  title TEXT,
  department_id TEXT,
  manager_id TEXT,
  employment_type TEXT DEFAULT 'full_time',
  status TEXT DEFAULT 'active',
  hire_date TEXT,
  termination_date TEXT,
  salary REAL DEFAULT 0,
  pay_rate REAL DEFAULT 0,
  pay_type TEXT DEFAULT 'salary',
  address TEXT,
  city TEXT,
  state TEXT,
  zip TEXT,
  date_of_birth TEXT,
  emergency_contact_name TEXT,
  emergency_contact_phone TEXT,
  notes TEXT,
  avatar_url TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  FOREIGN KEY (department_id) REFERENCES departments(id)
);
CREATE INDEX IF NOT EXISTS idx_emp_tenant ON employees(tenant_id);
CREATE INDEX IF NOT EXISTS idx_emp_dept ON employees(tenant_id, department_id);
CREATE INDEX IF NOT EXISTS idx_emp_status ON employees(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_emp_manager ON employees(manager_id);
CREATE INDEX IF NOT EXISTS idx_emp_number ON employees(tenant_id, employee_number);

CREATE TABLE IF NOT EXISTS time_entries (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  employee_id TEXT NOT NULL,
  date TEXT NOT NULL,
  clock_in TEXT,
  clock_out TEXT,
  hours REAL DEFAULT 0,
  overtime_hours REAL DEFAULT 0,
  break_minutes INTEGER DEFAULT 0,
  type TEXT DEFAULT 'regular',
  project TEXT,
  notes TEXT,
  status TEXT DEFAULT 'pending',
  approved_by TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (employee_id) REFERENCES employees(id)
);
CREATE INDEX IF NOT EXISTS idx_time_emp ON time_entries(employee_id);
CREATE INDEX IF NOT EXISTS idx_time_date ON time_entries(tenant_id, date);
CREATE INDEX IF NOT EXISTS idx_time_status ON time_entries(tenant_id, status);

CREATE TABLE IF NOT EXISTS leave_types (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  days_per_year REAL DEFAULT 0,
  carry_over INTEGER DEFAULT 0,
  max_carry_over REAL DEFAULT 0,
  requires_approval INTEGER DEFAULT 1,
  paid INTEGER DEFAULT 1,
  color TEXT DEFAULT '#3b82f6',
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);
CREATE INDEX IF NOT EXISTS idx_ltype_tenant ON leave_types(tenant_id);

CREATE TABLE IF NOT EXISTS leave_requests (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  employee_id TEXT NOT NULL,
  leave_type_id TEXT NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  days REAL DEFAULT 1,
  reason TEXT,
  status TEXT DEFAULT 'pending',
  approved_by TEXT,
  approved_at TEXT,
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (employee_id) REFERENCES employees(id),
  FOREIGN KEY (leave_type_id) REFERENCES leave_types(id)
);
CREATE INDEX IF NOT EXISTS idx_leave_emp ON leave_requests(employee_id);
CREATE INDEX IF NOT EXISTS idx_leave_status ON leave_requests(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_leave_date ON leave_requests(tenant_id, start_date);

CREATE TABLE IF NOT EXISTS leave_balances (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  employee_id TEXT NOT NULL,
  leave_type_id TEXT NOT NULL,
  year INTEGER NOT NULL,
  entitled REAL DEFAULT 0,
  used REAL DEFAULT 0,
  carried_over REAL DEFAULT 0,
  adjustment REAL DEFAULT 0,
  FOREIGN KEY (employee_id) REFERENCES employees(id),
  FOREIGN KEY (leave_type_id) REFERENCES leave_types(id)
);
CREATE INDEX IF NOT EXISTS idx_lbal_emp ON leave_balances(employee_id, year);
CREATE UNIQUE INDEX IF NOT EXISTS idx_lbal_unique ON leave_balances(employee_id, leave_type_id, year);

CREATE TABLE IF NOT EXISTS payroll_runs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  run_date TEXT DEFAULT (datetime('now')),
  status TEXT DEFAULT 'draft',
  total_gross REAL DEFAULT 0,
  total_deductions REAL DEFAULT 0,
  total_net REAL DEFAULT 0,
  employee_count INTEGER DEFAULT 0,
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);
CREATE INDEX IF NOT EXISTS idx_payroll_tenant ON payroll_runs(tenant_id);
CREATE INDEX IF NOT EXISTS idx_payroll_period ON payroll_runs(tenant_id, period_start);

CREATE TABLE IF NOT EXISTS payroll_items (
  id TEXT PRIMARY KEY,
  payroll_run_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  employee_id TEXT NOT NULL,
  regular_hours REAL DEFAULT 0,
  overtime_hours REAL DEFAULT 0,
  gross_pay REAL DEFAULT 0,
  federal_tax REAL DEFAULT 0,
  state_tax REAL DEFAULT 0,
  social_security REAL DEFAULT 0,
  medicare REAL DEFAULT 0,
  other_deductions REAL DEFAULT 0,
  net_pay REAL DEFAULT 0,
  FOREIGN KEY (payroll_run_id) REFERENCES payroll_runs(id),
  FOREIGN KEY (employee_id) REFERENCES employees(id)
);
CREATE INDEX IF NOT EXISTS idx_pitems_run ON payroll_items(payroll_run_id);
CREATE INDEX IF NOT EXISTS idx_pitems_emp ON payroll_items(employee_id);

CREATE TABLE IF NOT EXISTS performance_reviews (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  employee_id TEXT NOT NULL,
  reviewer_id TEXT,
  review_period TEXT,
  overall_rating REAL,
  ratings_json TEXT DEFAULT '{}',
  strengths TEXT,
  improvements TEXT,
  goals TEXT,
  comments TEXT,
  employee_comments TEXT,
  status TEXT DEFAULT 'draft',
  completed_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (employee_id) REFERENCES employees(id)
);
CREATE INDEX IF NOT EXISTS idx_review_emp ON performance_reviews(employee_id);
CREATE INDEX IF NOT EXISTS idx_review_tenant ON performance_reviews(tenant_id);

CREATE TABLE IF NOT EXISTS onboarding_templates (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  department_id TEXT,
  tasks_json TEXT DEFAULT '[]',
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);
CREATE INDEX IF NOT EXISTS idx_onboard_tenant ON onboarding_templates(tenant_id);

CREATE TABLE IF NOT EXISTS onboarding_progress (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  employee_id TEXT NOT NULL,
  template_id TEXT NOT NULL,
  tasks_status_json TEXT DEFAULT '{}',
  assigned_at TEXT DEFAULT (datetime('now')),
  completed_at TEXT,
  FOREIGN KEY (employee_id) REFERENCES employees(id),
  FOREIGN KEY (template_id) REFERENCES onboarding_templates(id)
);
CREATE INDEX IF NOT EXISTS idx_onbprog_emp ON onboarding_progress(employee_id);

CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  employee_id TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT DEFAULT 'general',
  url TEXT,
  expiry_date TEXT,
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (employee_id) REFERENCES employees(id)
);
CREATE INDEX IF NOT EXISTS idx_docs_emp ON documents(employee_id);
CREATE INDEX IF NOT EXISTS idx_docs_expiry ON documents(tenant_id, expiry_date);

CREATE TABLE IF NOT EXISTS activity_log (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL,
  actor_id TEXT,
  details TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_activity_tenant ON activity_log(tenant_id);
