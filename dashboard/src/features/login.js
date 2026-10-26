// Login feature: password form + cookie issue. Public routes (no auth gate).
import { checkPassword, authCookieHeader } from '../core/auth.js';
import { layout, esc, u } from '../core/layout.js';

function loginPage(error) {
  return layout({
    title: 'Login — Shoemaker',
    bare: true,
    body: `
    <section class="card login">
      <h1>Shoemaker</h1>
      ${error ? `<p class="error">${esc(error)}</p>` : ''}
      <form method="POST" action="${u('/login')}">
        <input type="password" name="password" placeholder="Password" autofocus required>
        <button type="submit">Sign in</button>
      </form>
    </section>`,
  });
}

export default {
  id: 'login',
  order: 0,
  routes: [
    { method: 'GET', path: '/login', public: true, handler: (ctx) => ctx.send(200, loginPage()) },
    {
      method: 'POST', path: '/login', public: true,
      handler: async (ctx) => {
        const b = await ctx.body();
        if (checkPassword(b.password)) {
          return ctx.redirect('/', { 'Set-Cookie': authCookieHeader() });
        }
        ctx.send(401, loginPage('Wrong password.'));
      },
    },
  ],
};
