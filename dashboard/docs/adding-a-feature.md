# Adding a feature / page

This project is built so a new page is **one file** in `src/features/`. The
registry auto-discovers it — you never edit `server.js` or a route table.

> Mental model: **you steer, the agent executes.** Follow this recipe; the
> feedback loop (`npm run check`) tells you when you're done.

---

## The 3-step loop

1. **Scaffold**
   ```bash
   npm run new:page <name> "Nav Label"
   # e.g. npm run new:page pdf "Paper"
   ```
   Creates `src/features/<name>.js` wired to `GET /<name>` with a nav entry.

2. **Edit** `src/features/<name>.js` — build the view and add routes (see the
   feature API below).

3. **Verify**
   ```bash
   npm run check      # syntax + tests; failures print what to fix
   ```
   Then `npm start` and open the page. Add a test in `test/` for new behavior.

---

## Feature module shape

A feature is a default export:

```js
export default {
  id: 'pdf',                              // unique id
  order: 50,                              // nav/dispatch order (lower = earlier)
  nav: { label: 'Paper', href: '/pdf' }, // omit to hide from the top nav
  init: (db) => {},                       // optional: create tables once at boot
  routes: [
    { method: 'GET', path: '/pdf', handler: (ctx) => { /* ... */ } },
    // path supports :params, e.g. '/pdf/:id'
    // add `public: true` to bypass the auth gate (login uses this)
  ],
};
```

## The `ctx` object (handler API)

Defined in `src/core/context.js`. This is the stable surface — prefer it over
reaching into core internals.

| Member | Use |
|---|---|
| `ctx.page({ title, body, bare? })` | Render a full HTML page with nav + theme. `body` is HTML. |
| `ctx.json(status, obj)` | Send a JSON response. |
| `ctx.send(status, body, headers?)` | Send a raw response (e.g. a file buffer). |
| `ctx.redirect(location, headers?)` | 302 redirect. |
| `ctx.notFound(msg?)` | 404. |
| `await ctx.body()` | Parsed request body (JSON or form). |
| `ctx.params` | Path params, e.g. `ctx.params.id`. |
| `ctx.query` | `URLSearchParams` of the query string. |
| `ctx.db` | `better-sqlite3` handle (`ctx.db.prepare(...).run/get/all`). |
| `ctx.settings()` | Dashboard config row (project_name, theme, show_completed, todo_view). |
| `ctx.runtime` | `dashboard.json` values — **`ctx.runtime.target_dir`** is the managed repository's path, when set. |

**Always** escape user/db content in views with `esc()` from `src/core/layout.js`.

---

## Worked example: a PDF viewer page

Goal: a "Paper" page that displays `paper/main.pdf` from the managed
repository. It needs `target_dir` in `dashboard.json`.

```bash
npm run new:page pdf "Paper"
```

Then replace `src/features/pdf.js` with:

```js
// Paper page: embeds <target_dir>/paper/main.pdf.
import { readFile } from 'node:fs/promises';
import { join, normalize } from 'node:path';
import { esc } from '../core/layout.js';

const REL = 'paper/main.pdf'; // path within the target project

function view() {
  return `
    <h1>Paper</h1>
    <iframe class="pdf-frame" src="/pdf/file" title="main.pdf"></iframe>`;
}

export default {
  id: 'pdf',
  order: 20,
  nav: { label: 'Paper', href: '/pdf' },
  routes: [
    { method: 'GET', path: '/pdf', handler: (ctx) => ctx.page({ title: 'Paper', body: view() }) },

    // Stream the actual PDF. Validate the path stays inside target_dir.
    { method: 'GET', path: '/pdf/file', handler: async (ctx) => {
      const baseDir = normalize(ctx.runtime.target_dir);
      const file = normalize(join(baseDir, REL));
      if (!file.startsWith(baseDir)) return ctx.send(403, 'Forbidden');
      try {
        const buf = await readFile(file);
        ctx.send(200, buf, { 'Content-Type': 'application/pdf' });
      } catch {
        ctx.send(404, `Not found: ${esc(REL)} in target project.`);
      }
    } },
  ],
};
```

Add some CSS to `public/app.css` (optional):

```css
.pdf-frame { width: 100%; height: 80vh; border: 1px solid var(--stitch); }   /* corners stay square */
```

Verify:

```bash
npm run check && npm start   # open http://127.0.0.1:6531/pdf
```

That's the whole feature — no other file changes.

---

## Conventions (the harness rules)

**Always**
- Put new pages in `src/features/`; keep generic plumbing in `src/core/`.
- Escape output with `esc()`. Use parameterized SQL (`?` placeholders).
- Add/adjust a test in `test/` for new behavior; run `npm run check` before done.
- Change a todo's status only through `src/queue.js`, which checks the move and logs it.

**Ask first** (changes the project's shape — confirm with the user)
- Adding a runtime dependency (the project is intentionally near-zero-dep).
- Changing the auth model or the DB schema of existing tables.
- Adding a build step or frontend framework.

**Never**
- Give agents a way to approve, prioritise, reject or restore todos: those are the human's.
- Commit `config.json`, `data/`, `dashboard.json`, `queue.db`, or secrets.
- Bypass `esc()` for user/db-derived HTML.
