import React from 'react';
import { getDailyBudget } from '../../../applications/papp-sdk/src/browser';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import App from '../baseapp/pages/_app';
import Home from '../baseapp/pages/index';
import Article from './pages/article/[slug]';
import Profile from '../baseapp/pages/profile/[username]';
import Editor from '../baseapp/pages/editor/index';
import Edit from '../baseapp/pages/editor/[slug]';
import Settings from '../baseapp/pages/settings';
import Login from '../baseapp/pages/login';
import Register from '../baseapp/pages/register';
import { callback } from './adapters/oidc';
import NotFound from '../baseapp/pages/404';
const page = (Component: any) => <App Component={Component} pageProps={{}} router={null as any} />;
if (location.pathname === '/callback') callback().catch(error => { document.getElementById('root')!.textContent = error.message; });
else getDailyBudget().then(budget => {
  const label = document.createElement('p'); label.textContent = 'Daily budget: ';
  const value = document.createElement('span'); value.id = 'daily-budget'; value.textContent = budget.dailyBudget; label.append(value); document.body.append(label);
  createRoot(document.getElementById('root')!).render(<BrowserRouter><Routes>
  <Route path="/" element={page(Home)} /><Route path="/article/:slug" element={page(Article)} />
  <Route path="/profile/:username" element={page(Profile)} /><Route path="/editor" element={page(Editor)} />
  <Route path="/editor/:slug" element={page(Edit)} /><Route path="/settings" element={page(Settings)} />
  <Route path="/login" element={page(Login)} /><Route path="/register" element={page(Register)} />
  <Route path="*" element={page(NotFound)} />
</Routes></BrowserRouter>);
}).catch(error => { document.getElementById('root')!.textContent = error.message; });
