// SQLite schema + connection: the queue, one local file.
//   SHOEMAKER_STATE=<dir>   uses <dir>/queue.db
//   SHOEMAKER_DB            overrides the file itself (tests)
// With neither, a development checkout uses dashboard/data/queue.db.
// The web server and the agents' CLI (bin/queue.mjs) open the same file;
// WAL mode and a busy timeout let them write side by side.
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const STATE = process.env.SHOEMAKER_STATE;
export const DB_PATH = process.env.SHOEMAKER_DB
  || (STATE ? join(STATE, 'queue.db') : join(ROOT, 'data', 'queue.db'));

mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new Database(DB_PATH, { timeout: 5000 });
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Columns added to `todos` for the agent queue (the repository's docs/queue.md).
const TODO_QUEUE_COLUMNS = {
  status: "TEXT NOT NULL DEFAULT 'proposed'",
  priority: 'INTEGER NOT NULL DEFAULT 0', // 0 Auto, 1 High, 2 Normal, 3 Low
  source: "TEXT NOT NULL DEFAULT 'you'",
  run_id: 'TEXT',        // the run that suggested it
  last_run: 'TEXT',      // the last run that worked on it
  branch: 'TEXT',
  pr_url: 'TEXT',        // the item's pull request (GitHub) or merge request (GitLab)
  attempts: 'INTEGER NOT NULL DEFAULT 0',
  approved_at: 'TEXT',
  shipped_at: 'TEXT',
  archived_at: 'TEXT',
  status_note: 'TEXT',   // why it was archived or failed
  updated_at: 'TEXT',
  suggested_priority: 'INTEGER', // the suggestion agent's recommendation, used while priority is 0 (Auto)
  auto_approval_blocked: 'INTEGER NOT NULL DEFAULT 0', // sent back to review by the human
};

// One write-locked transaction: the web server and the CLI may start together on
// an old database, and a migration must never be left half done.
export function initSchema() {
  db.transaction(migrate).immediate();
}

function migrate() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS config (
      id            INTEGER PRIMARY KEY CHECK (id = 1),
      project_name  TEXT    NOT NULL DEFAULT 'My Project',
      show_completed INTEGER NOT NULL DEFAULT 1,
      theme         TEXT    NOT NULL DEFAULT 'light',
      container_align TEXT  NOT NULL DEFAULT 'center',
      todo_view     TEXT    NOT NULL DEFAULT 'list',
      auto_approve  INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS todos (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      title       TEXT    NOT NULL,
      done        INTEGER NOT NULL DEFAULT 0,
      explanation TEXT    NOT NULL DEFAULT '',
      position    INTEGER NOT NULL DEFAULT 0,
      created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS todo_deps (
      todo_id INTEGER NOT NULL REFERENCES todos(id) ON DELETE CASCADE,
      dep_id  INTEGER NOT NULL REFERENCES todos(id) ON DELETE CASCADE,
      PRIMARY KEY (todo_id, dep_id),
      CHECK (todo_id <> dep_id)
    );

    CREATE INDEX IF NOT EXISTS idx_todo_deps_dep ON todo_deps(dep_id);

    CREATE TABLE IF NOT EXISTS comments (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      todo_id    INTEGER NOT NULL REFERENCES todos(id) ON DELETE CASCADE,
      body       TEXT    NOT NULL,
      created_at TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_comments_todo ON comments(todo_id);
  `);

  // Migrations: add columns introduced after the initial schema (existing DBs).
  const cols = (table) => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);

  const configCols = cols('config');
  if (!configCols.includes('container_align')) {
    db.exec("ALTER TABLE config ADD COLUMN container_align TEXT NOT NULL DEFAULT 'center'");
  }
  if (!configCols.includes('todo_view')) {
    db.exec("ALTER TABLE config ADD COLUMN todo_view TEXT NOT NULL DEFAULT 'list'");
  }
  if (!configCols.includes('auto_approve')) {
    db.exec('ALTER TABLE config ADD COLUMN auto_approve INTEGER NOT NULL DEFAULT 0');
  }

  // An imported project-dashboard database names the link mr_url, and may
  // still hold an unused due_date column (harmless; nothing reads it).
  if (cols('todos').includes('mr_url') && !cols('todos').includes('pr_url')) {
    db.exec('ALTER TABLE todos RENAME COLUMN mr_url TO pr_url');
  }
  const todoCols = cols('todos');
  for (const [name, type] of Object.entries(TODO_QUEUE_COLUMNS)) {
    if (!todoCols.includes(name)) db.exec(`ALTER TABLE todos ADD COLUMN ${name} ${type}`);
  }
  // Auto priority arrived with suggested_priority: items still waiting for
  // review had no priority chosen yet, so they start at Auto (once).
  if (!todoCols.includes('suggested_priority')) {
    db.exec("UPDATE todos SET priority = 0 WHERE status = 'proposed'");
  }
  // Todos from before the queue: done ones count as shipped; open ones wait for
  // review, so nothing old is ever implemented without an explicit approval.
  // (The queue keeps done = 1 for shipped items only, so this is a no-op after.)
  db.exec("UPDATE todos SET status = 'shipped' WHERE done = 1 AND status <> 'shipped'");

  if (!cols('comments').includes('author')) {
    db.exec("ALTER TABLE comments ADD COLUMN author TEXT NOT NULL DEFAULT 'you'");
  }
  if (!todoCols.includes('auto_approval_blocked')) {
    db.exec(`UPDATE todos SET auto_approval_blocked = 1 WHERE id IN
      (SELECT todo_id FROM comments WHERE body IN ('Moved back to review.', 'Restored for review.'))`);
  }

  // One final vote per logical agent; the item log retains every discussion turn.
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_reviews (
      todo_id INTEGER NOT NULL REFERENCES todos(id) ON DELETE CASCADE,
      run_id TEXT NOT NULL,
      stage_id TEXT NOT NULL,
      role_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      authority TEXT NOT NULL CHECK (authority IN ('advisory', 'filter', 'approve')),
      verdict TEXT NOT NULL CHECK (verdict IN ('approve', 'reject', 'abstain')),
      body TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (todo_id, run_id, stage_id, agent_id)
    );
    CREATE TABLE IF NOT EXISTS agent_review_decisions (
      todo_id INTEGER NOT NULL REFERENCES todos(id) ON DELETE CASCADE,
      run_id TEXT NOT NULL,
      stage_id TEXT NOT NULL,
      authority TEXT NOT NULL,
      decision TEXT NOT NULL,
      PRIMARY KEY (todo_id, run_id, stage_id)
    );
    CREATE TABLE IF NOT EXISTS auto_approval_holds (
      todo_id INTEGER PRIMARY KEY REFERENCES todos(id) ON DELETE CASCADE,
      fingerprint TEXT NOT NULL
    );
    -- Keep the quota consumed even if the human later deletes an idea.
    CREATE TABLE IF NOT EXISTS team_proposals (
      run_id TEXT NOT NULL,
      todo_id INTEGER NOT NULL,
      PRIMARY KEY (run_id, todo_id)
    );
  `);

  // Ensure the single config row exists.
  db.prepare(`INSERT OR IGNORE INTO config (id) VALUES (1)`).run();
}

// Allow `node src/db.js --init` (npm run init-db).
if (process.argv.includes('--init')) {
  initSchema();
  console.log('DB initialized at', DB_PATH);
}
