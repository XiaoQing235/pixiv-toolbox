import { createApp } from 'vue';
import App from './App.vue';
import css from './style.css?inline';
import type { Services } from '../types';

export function mount(services: Services): () => void {
  const host = document.createElement('div');
  host.id = 'pixiv-toolbox';
  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = css;
  const root = document.createElement('div');
  shadow.append(style, root);
  document.documentElement.append(host);
  const app = createApp(App, { services, host });
  app.mount(root);
  return () => { app.unmount(); host.remove(); };
}
