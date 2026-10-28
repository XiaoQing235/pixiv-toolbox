import type { Ref } from './types';
import { refKey } from './rules';
export { inTrigger, refKey } from './rules';

export interface Card { ref: Ref; element: HTMLAnchorElement; image: HTMLImageElement | null }

export function parseRef(href: string, base = 'https://www.pixiv.net/'): Ref | null {
  try {
    const url = new URL(href, base);
    if (!['www.pixiv.net', 'pixiv.net'].includes(url.hostname)) return null;
    const artwork = url.pathname.match(/^\/(?:[a-z]{2}\/)?artworks\/(\d+)\/?$/);
    if (artwork) return { kind: 'illust', id: artwork[1]! };
    if (/^\/(?:[a-z]{2}\/)?novel\/show\.php$/.test(url.pathname)) {
      const id = url.searchParams.get('id');
      if (id && /^\d+$/.test(id)) return { kind: 'novel', id };
    }
  } catch { /* A malformed link is not a work. */ }
  return null;
}

export function scanCards(root: ParentNode = document): Card[] {
  const anchors = [...root.querySelectorAll<HTMLAnchorElement>('a[href]')];
  if (root instanceof HTMLAnchorElement && root.hasAttribute('href')) anchors.unshift(root);
  return anchors.flatMap(element => {
    const ref = parseRef(element.href);
    return ref ? [{ ref, element, image: element.querySelector<HTMLImageElement>('img') }] : [];
  });
}

/** Only added/reused anchors are rescanned; the full document is visited once. */
export function watchCards(callback: (cards: Card[], routeChanged: boolean) => void, root: Document | HTMLElement = document): () => void {
  const cards = new Map<HTMLAnchorElement, Card>();
  let href = location.href;
  let queued = false;
  let stopped = false;
  const add = (node: ParentNode) => { for (const card of scanCards(node)) cards.set(card.element, card); };
  const flush = () => {
    queued = false;
    if (stopped) return;
    const changed = href !== location.href;
    href = location.href;
    for (const [element] of cards) if (!element.isConnected) cards.delete(element);
    callback([...cards.values()], changed);
  };
  const queue = () => { if (!queued) { queued = true; queueMicrotask(flush); } };
  add(root);
  flush();
  const observer = new MutationObserver(records => {
    for (const record of records) {
      if (record.type === 'attributes' && record.target instanceof HTMLAnchorElement) {
        cards.delete(record.target);
        add(record.target);
      } else for (const node of record.addedNodes) if (node instanceof Element) {
        add(node);
        const anchor = node.closest<HTMLAnchorElement>('a[href]');
        if (anchor) add(anchor);
      }
    }
    queue();
  });
  observer.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ['href'] });
  const routeTimer = window.setInterval(() => { if (!document.hidden && href !== location.href) queue(); }, 600);
  const onRoute = () => queue();
  window.addEventListener('popstate', onRoute);
  return () => { stopped = true; observer.disconnect(); clearInterval(routeTimer); window.removeEventListener('popstate', onRoute); };
}

/** Abort and generation checks both matter: a transport may finish after abort. */
export function latestRequest<T>(load: (ref: Ref, signal: AbortSignal) => Promise<T>) {
  let generation = 0;
  let active: { key: string; controller: AbortController; promise: Promise<T | undefined> } | undefined;
  return {
    request(ref: Ref): Promise<T | undefined> {
      const key = refKey(ref);
      if (active?.key === key) return active.promise;
      active?.controller.abort();
      const controller = new AbortController();
      const version = ++generation;
      const promise = load(ref, controller.signal).then(value => version === generation && !controller.signal.aborted ? value : undefined).catch(error => {
        if (version !== generation || controller.signal.aborted) return undefined;
        active = undefined;
        throw error;
      });
      active = { key, controller, promise };
      return promise;
    },
    cancel() { generation++; active?.controller.abort(); active = undefined; },
  };
}
