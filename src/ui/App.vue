<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, shallowRef, watch } from 'vue';
import type { Card } from '../site';
import { inTrigger, latestRequest, parseRef, refKey, watchCards } from '../site';
import { matches, parsePages } from '../rules';
import type { CloudConfig, Reading, Ref, Schedule, Services, Settings, Task, Work } from '../types';

const props = defineProps<{ services: Services; host: HTMLElement }>();
const services = props.services;
const draft = reactive<Settings>(structuredClone(services.settings));
const tab = ref<'works' | 'tasks' | 'history' | 'settings' | null>(location.protocol === 'chrome-extension:' ? 'settings' : null);
const notice = ref('');
const busy = ref(false);
const cards = shallowRef<Card[]>([]);
const extraRefs = ref<Ref[]>([]);
const works = reactive(new Map<string, Work>());
const selected = reactive(new Set<string>());
const histories = ref<Reading[]>([]);
const tasks = ref<Task[]>([]);
const schedules = ref<Schedule[]>([]);
const cloud = reactive<CloudConfig>({ url: '', username: '', password: '', upload: false });
const syncConflict = ref(false);
const scheduleSource = ref(location.href);
const scheduleEvery = ref(60);
const scheduleLimit = ref(30);
const search = ref('');
const sort = ref(false);
const windowStart = ref(0);
const windowSize = 30;
const listPage = ref(Math.max(1, Number(new URL(location.href).searchParams.get('p')) || 1));
const hasNext = ref(true);
const paging = ref(false);
const autoPage = ref(false);
const listEnd = ref<HTMLElement>();
const current = shallowRef<Work>();
const bookmarkTags = ref('');
const privateBookmark = ref(false);
const chosenPages = ref('');
watch(() => current.value ? refKey(current.value) : '', () => { bookmarkTags.value = ''; privateBookmark.value = false; chosenPages.value = ''; });
const target = shallowRef<Ref>();
const loading = ref(false);
const viewerError = ref('');
const pinned = ref(false);
const viewer = ref<HTMLElement>();
const toolbar = ref<HTMLButtonElement>();
const novelBody = ref<HTMLElement>();
const page = ref(0);
const zoom = ref(1);
const rotation = ref(0);
const pan = reactive({ x: 0, y: 0 });
const fontSize = ref(18);
const lineHeight = ref(1.9);
const progress = ref(0);
const frame = ref(0);
const playing = ref(true);
const speed = ref(1);
const canvas = ref<HTMLCanvasElement>();
const animation = shallowRef<Awaited<ReturnType<Services['media']['frames']>>>();
const animationLoading = ref(false);
const animationError = ref('');
const cardRect = shallowRef<DOMRect>();
let activeCard: Card | undefined;
let anchorIndex = 0;
let loadVersion = 0;
let warmController = new AbortController();
let warmImages: HTMLImageElement[] = [];
let animationController = new AbortController();
let animationVersion = 0;
let raf = 0;
let lastFrame = 0;
let readTimer = 0;
let stopCards: (() => void) | undefined;
let unsubscribe: (() => void) | undefined;
let intersection: IntersectionObserver | undefined;
let alive = true;
let refreshing: Promise<void> | undefined;
let previousFocus: HTMLElement | null = null;
const adsStyle = document.createElement('style');
let siteObserver: IntersectionObserver | undefined;
const siteObserved = new Map<HTMLAnchorElement, Card>();
const siteVisible = new Set<HTMLAnchorElement>();
const siteAttempted = new Set<string>();
const sitePending = new Map<string, AbortSignal>();
const siteStyled = new Set<HTMLElement>();
let siteController = new AbortController();
let siteInFlight = 0;


const refs = computed(() => {
  const currentRef = parseRef(location.href);
  return [...new Map([...cards.value.map(card => card.ref), ...extraRefs.value, ...(currentRef ? [currentRef] : [])].map(item => [refKey(item), item])).values()];
});
const readKeys = computed(() => new Set(histories.value.map(item => refKey(item.ref))));
function allowed(work: Work): boolean { return matches(work, draft.filter, readKeys.value); }
const visibleRefs = computed(() => {
  const query = search.value.trim().toLowerCase();
  const result = refs.value.filter(item => {
    const work = works.get(refKey(item));
    return work ? allowed(work) && (!query || `${work.title} ${work.userName} ${work.tags.join(' ')}`.toLowerCase().includes(query)) : !query;
  });
  return sort.value ? result.slice().sort((a, b) => (works.get(refKey(b))?.bookmarkCount ?? -1) - (works.get(refKey(a))?.bookmarkCount ?? -1)) : result;
});
const windowRefs = computed(() => visibleRefs.value.slice(windowStart.value, windowStart.value + windowSize));
const visible = computed(() => !!target.value);
const pageImage = computed(() => current.value?.pages[page.value]);
const thumbnailStart = computed(() => Math.max(0, page.value - 5));
const thumbnailPages = computed(() => current.value?.pages.slice(thumbnailStart.value, thumbnailStart.value + 11) ?? []);
const imageStyle = computed(() => ({ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom.value}) rotate(${rotation.value}deg)` }));
const viewerStyle = computed(() => {
  if (tab.value === 'works') return {};
  const width = Math.min(820, window.innerWidth - 28);
  const height = Math.min(760, window.innerHeight - 36);
  const rect = cardRect.value;
  const rightSpace = rect ? window.innerWidth - rect.right - 16 : 0;
  const left = !pinned.value && rect && rightSpace >= Math.min(width, 460)
    ? Math.min(rect.right + 12, window.innerWidth - width - 14)
    : !pinned.value && rect && rect.left > width + 16 ? rect.left - width - 12 : (window.innerWidth - width) / 2;
  return { width: `${width}px`, height: `${height}px`, left: `${Math.max(14, left)}px`, top: `${Math.max(18, Math.min(rect?.top ?? 60, window.innerHeight - height - 18))}px` };
});

function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }
async function action(run: () => Promise<unknown>, message = '') {
  if (busy.value) return;
  busy.value = true;
  try { await run(); if (message) notice.value = message; }
  catch (error) { notice.value = errorText(error); }
  finally { busy.value = false; }
}
function remember(work: Work) {
  works.set(refKey(work), work);
  applySiteWork(work);
  // Keep current/window metadata; older off-screen entries are reloadable.
  if (works.size > 180) {
    const keep = new Set(windowRefs.value.map(refKey));
    if (current.value) keep.add(refKey(current.value));
    for (const key of works.keys()) { if (!keep.has(key)) works.delete(key); if (works.size <= 150) break; }
  }
}
function cardHost(card: Card): HTMLElement {
  const container = card.element.closest<HTMLElement>('li,article');
  if (container) {
    const linked = [...container.querySelectorAll<HTMLAnchorElement>('a[href]')].map(anchor => parseRef(anchor.href)).filter((item): item is Ref => !!item);
    if (linked.length && linked.every(item => refKey(item) === refKey(card.ref))) return container;
  }
  return card.element;
}
function applySiteWork(work: Work) {
  for (const card of siteObserved.values()) if (refKey(card.ref) === refKey(work)) {
    const node = cardHost(card); siteStyled.add(node);
    node.toggleAttribute('data-pt-hidden', !matches(work, services.settings.filter, readKeys.value));
    node.toggleAttribute('data-pt-following', work.following);
  }
}
function restoreSiteStyles() { for (const node of siteStyled) { node.removeAttribute('data-pt-hidden'); node.removeAttribute('data-pt-following'); } siteStyled.clear(); }
function updateSiteCards(items: Card[]) {
  const live = new Set(items.map(card => card.element));
  for (const [element, previous] of siteObserved) if (!live.has(element)) { siteObserver?.unobserve(element); siteObserved.delete(element); siteVisible.delete(element); siteAttempted.delete(refKey(previous.ref)); const node = cardHost(previous); node.removeAttribute('data-pt-hidden'); node.removeAttribute('data-pt-following'); siteStyled.delete(node); }
  for (const card of items) {
    const previous = siteObserved.get(card.element);
    siteObserved.set(card.element, card);
    if (!previous) siteObserver?.observe(card.element);
    const known = works.get(refKey(card.ref));
    if (known) applySiteWork(known);
  }
  pumpSiteQueue();
}
function pumpSiteQueue() {
  if (document.hidden || !alive || siteInFlight >= 2) return;
  for (const element of siteVisible) {
    const card = siteObserved.get(element);
    if (!card) continue;
    const key = refKey(card.ref), known = works.get(key);
    if (known) { applySiteWork(known); continue; }
    if (siteAttempted.has(key)) continue;
    siteAttempted.add(key); siteInFlight++;
    const signal = siteController.signal;
    sitePending.set(key, signal);
    void services.client.work(card.ref, signal).then(work => { if (!signal.aborted && alive) remember(work); }).catch(() => { /* Original cards remain visible if details cannot be read. */ }).finally(() => { if (sitePending.get(key) === signal) sitePending.delete(key); siteInFlight--; pumpSiteQueue(); });
    if (siteInFlight >= 2) break;
  }
}
function resetSiteFilter() {
  restoreSiteStyles();
  for (const work of works.values()) applySiteWork(work);
  pumpSiteQueue();
}
const loader = latestRequest<Work>(async (item, signal) => works.get(refKey(item)) ?? services.client.work(item, signal));
async function openWork(item: Ref, pin = true, card?: Card) {
  if (target.value && refKey(target.value) === refKey(item)) {
    if (pin) { pinned.value = true; viewer.value?.focus({ preventScroll: true }); }
    if (card) { activeCard = card; cardRect.value = (card.image ?? card.element).getBoundingClientRect(); }
    return;
  }
  if (pin && !visible.value) previousFocus = props.host.shadowRoot?.activeElement as HTMLElement ?? document.activeElement as HTMLElement;
  target.value = item;
  pinned.value = pin;
  activeCard = card;
  cardRect.value = card ? (card.image ?? card.element).getBoundingClientRect() : undefined;
  current.value = undefined;
  loading.value = true;
  viewerError.value = '';
  resetTransform();
  page.value = 0;
  releaseAnimation();
  const version = ++loadVersion;
  try {
    const work = await loader.request(item);
    if (!work || version !== loadVersion || !alive) return;
    remember(work);
    current.value = work;
    const reading = histories.value.find(entry => refKey(entry.ref) === refKey(item));
    page.value = Math.min(reading?.page ?? 0, Math.max(0, work.pages.length - 1));
    progress.value = reading?.position ?? 0;
    await nextTick();
    if (novelBody.value) novelBody.value.scrollTop = progress.value * Math.max(0, novelBody.value.scrollHeight - novelBody.value.clientHeight);
    if (pin) viewer.value?.focus({ preventScroll: true });
    if (work.animation) void loadAnimation(work);
    saveReading();
    warmNeighbors(item);
  } catch (error) { if (version === loadVersion) viewerError.value = errorText(error); }
  finally { if (version === loadVersion) loading.value = false; }
}
function closeViewer() {
  loadVersion++;
  loader.cancel();
  clearPreload();
  releaseAnimation();
  current.value = undefined;
  target.value = undefined;
  activeCard = undefined;
  if (document.fullscreenElement === props.host || document.fullscreenElement === viewer.value) void document.exitFullscreen();
  if (pinned.value) (previousFocus?.isConnected ? previousFocus : toolbar.value)?.focus({ preventScroll: true });
  pinned.value = false;
}
function retryWork() { const item = target.value; if (item) { target.value = undefined; void openWork(item, pinned.value, activeCard); } }
function resetTransform() { zoom.value = 1; rotation.value = 0; pan.x = 0; pan.y = 0; }
function movePage(delta: number) {
  if (!current.value || current.value.kind === 'novel') return;
  page.value = Math.max(0, Math.min(current.value.pages.length - 1, page.value + delta));
  resetTransform(); saveReading(); void warmNeighbors(current.value);
}
function moveWork(delta: number) {
  if (!target.value) return;
  const index = visibleRefs.value.findIndex(item => refKey(item) === refKey(target.value!));
  const item = visibleRefs.value[index + delta];
  if (item) void openWork(item);
}
function saveReading() {
  clearTimeout(readTimer);
  if (!current.value) return;
  const work = current.value, currentPage = page.value, position = progress.value;
  readTimer = window.setTimeout(() => { void services.read(work, currentPage, position).then(refresh).catch(error => { notice.value = errorText(error); }); }, 350);
}
function novelScroll() {
  const node = novelBody.value;
  if (node) progress.value = node.scrollTop / Math.max(1, node.scrollHeight - node.clientHeight);
  saveReading();
}
function seekNovel(event: Event) {
  const value = Number((event.target as HTMLInputElement).value);
  if (novelBody.value) novelBody.value.scrollTop = value * Math.max(0, novelBody.value.scrollHeight - novelBody.value.clientHeight);
}
function clearPreload() { warmController.abort(); for (const image of warmImages) image.src = ''; warmImages = []; }
async function warmNeighbors(item: Ref) {
  clearPreload();
  warmController = new AbortController();
  if (document.hidden) return;
  const signal = warmController.signal;
  const limit = Math.min(4, Math.max(0, draft.preload));
  const preload = (url: string) => { if (!url || warmImages.length >= limit) return; const image = new Image(); image.decoding = 'async'; image.src = url; warmImages.push(image); };
  if (current.value && refKey(current.value) === refKey(item)) for (const image of current.value.pages.slice(page.value + 1, page.value + 1 + limit)) preload(image.regular);
  const index = refs.value.findIndex(other => refKey(other) === refKey(item));
  const neighbors = refs.value.slice(index + 1, index + 1 + limit);
  for (const next of neighbors) {
    if (signal.aborted || document.hidden || warmImages.length >= limit) break;
    try {
      const work = works.get(refKey(next)) ?? await services.client.work(next, signal);
      if (!signal.aborted) { remember(work); preload(work.pages[0]?.regular || work.thumb); }
    } catch { break; }
  }
}
let metadataController = new AbortController();
async function loadWindow() {
  metadataController.abort(); metadataController = new AbortController();
  const signal = metadataController.signal;
  if (tab.value !== 'works' || document.hidden) return;
  const pending = windowRefs.value.filter(item => !works.has(refKey(item)));
  let index = 0;
  await Promise.all(Array.from({ length: Math.min(3, pending.length) }, async () => {
    while (index < pending.length && !signal.aborted) {
      const item = pending[index++]!;
      try { const work = await services.client.work(item, signal); if (!signal.aborted) remember(work); }
      catch (error) { if (!signal.aborted) notice.value = errorText(error); }
    }
  }));
}
function contains(rect: DOMRect, x: number, y: number) { return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom; }
function inBridge(x: number, y: number): boolean {
  const source = cardRect.value;
  if (!source || !viewer.value) return false;
  const preview = viewer.value.getBoundingClientRect();
  if (contains(source, x, y) || contains(preview, x, y)) return true;
  const left = source.right <= preview.left ? source : preview;
  const right = left === source ? preview : source;
  if (x < left.right || x > right.left || right.left <= left.right) return false;
  const t = (x - left.right) / (right.left - left.right);
  const middle = (left.top + left.height / 2) * (1 - t) + (right.top + right.height / 2) * t;
  return Math.abs(y - middle) <= Math.max(24, Math.min(source.height, preview.height) / 2);
}
function pointerMove(event: PointerEvent) {
  if (pinned.value || tab.value || !draft.hover || event.pointerType === 'touch') return;
  if (event.composedPath().includes(props.host)) return;
  const node = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a[href]') : null;
  const card = node ? cards.value.find(item => item.element === node) : undefined;
  if (card && inTrigger((card.image ?? card.element).getBoundingClientRect(), event.clientX, event.clientY, draft.hoverRatio)) {
    void openWork(card.ref, false, card);
    return;
  }
  if (visible.value && !inBridge(event.clientX, event.clientY)) closeViewer();
}
function onScroll() {
  if (activeCard && !pinned.value) { cardRect.value = (activeCard.image ?? activeCard.element).getBoundingClientRect(); if (cardRect.value.bottom < 0 || cardRect.value.top > innerHeight) closeViewer(); }
}
function pointerLeave(event: PointerEvent) { if (!event.relatedTarget && !pinned.value) closeViewer(); }
let dragging: { id: number; x: number; y: number } | undefined;
function startPan(event: PointerEvent) {
  if (event.button !== 0) return;
  pinned.value = true;
  viewer.value?.focus({ preventScroll: true });
  dragging = { id: event.pointerId, x: event.clientX - pan.x, y: event.clientY - pan.y };
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
}
function drag(event: PointerEvent) { if (dragging?.id === event.pointerId) { pan.x = event.clientX - dragging.x; pan.y = event.clientY - dragging.y; } }
function endPan() { dragging = undefined; }
function changeZoom(value: number) { zoom.value = Math.min(8, Math.max(0.1, value)); }
async function fullscreen() {
  try { if (document.fullscreenElement) await document.exitFullscreen(); else await viewer.value?.requestFullscreen(); }
  catch (error) { notice.value = errorText(error); }
}
function keydown(event: KeyboardEvent) {
  if (!visible.value || event.ctrlKey || event.metaKey || event.altKey) return;
  if (event.composedPath().some(node => node instanceof HTMLElement && (node.matches('input,textarea,select') || node.isContentEditable))) return;
  if (event.key === ' ' && event.composedPath().some(node => node instanceof HTMLElement && node.matches('button,a'))) return;
  const actions: Record<string, () => void> = { ArrowLeft: () => movePage(-1), ArrowRight: () => movePage(1), j: () => moveWork(1), k: () => moveWork(-1), f: () => { void fullscreen(); }, Escape: closeViewer };
  if (current.value?.animation) actions[' '] = () => { playing.value = !playing.value; };
  const run = actions[event.key];
  if (run) { event.preventDefault(); run(); }
}
function drawFrame() {
  const bitmap = animation.value?.images[frame.value];
  const node = canvas.value;
  if (bitmap && node) { if (node.width !== bitmap.width) node.width = bitmap.width; if (node.height !== bitmap.height) node.height = bitmap.height; node.getContext('2d')?.drawImage(bitmap, 0, 0); }
}
function tick(time: number) {
  raf = 0;
  const frames = animation.value;
  if (!frames || !playing.value || document.hidden) return;
  if (!lastFrame) lastFrame = time;
  if (time - lastFrame >= Math.max(10, frames.delays[frame.value] ?? 100) / speed.value) { frame.value = (frame.value + 1) % frames.images.length; lastFrame = time; drawFrame(); }
  raf = requestAnimationFrame(tick);
}
function startAnimation() { if (!raf && animation.value && playing.value && !document.hidden) { lastFrame = 0; raf = requestAnimationFrame(tick); } }
function releaseAnimation() { animationVersion++; animationController.abort(); cancelAnimationFrame(raf); raf = 0; animation.value?.dispose(); animation.value = undefined; animationLoading.value = false; animationError.value = ''; }
async function loadAnimation(work: Work) {
  releaseAnimation(); animationController = new AbortController();
  const version = animationVersion;
  animationLoading.value = true;
  try {
    const result = await services.media.frames(work, animationController.signal);
    if (version !== animationVersion || !alive) { result.dispose(); return; }
    animation.value = result; frame.value = 0; playing.value = true;
    await nextTick(); drawFrame(); startAnimation();
  } catch (error) { if (version === animationVersion) animationError.value = errorText(error); }
  finally { if (version === animationVersion) animationLoading.value = false; }
}
function stepFrame(delta: number) { if (!animation.value) return; playing.value = false; frame.value = (frame.value + delta + animation.value.images.length) % animation.value.images.length; drawFrame(); }
watch(playing, value => { if (value) startAnimation(); else { cancelAnimationFrame(raf); raf = 0; } });
async function refresh() {
  if (refreshing) return refreshing;
  refreshing = Promise.all([services.tasks(), services.history(), services.schedules()]).then(([taskItems, readings, scheduleItems]) => {
    if (alive) { tasks.value = taskItems; histories.value = readings; schedules.value = scheduleItems; }
  }).catch(error => { if (alive) notice.value = errorText(error); }).finally(() => { refreshing = undefined; });
  return refreshing;
}
async function setTab(value: typeof tab.value) {
  const wasOpen = tab.value;
  closeViewer();
  tab.value = wasOpen === value ? null : value;
  if (tab.value) { await refresh(); await nextTick(); if (tab.value === 'works') void loadWindow(); }
  if (tab.value === 'settings') try { Object.assign(cloud, await services.cloud() ?? { url: '', username: '', password: '', upload: false }); } catch (error) { notice.value = errorText(error); }
}
function select(item: Ref, event: MouseEvent) {
  const index = visibleRefs.value.findIndex(other => refKey(other) === refKey(item));
  if (event.shiftKey) for (const selectedRef of visibleRefs.value.slice(Math.min(index, anchorIndex), Math.max(index, anchorIndex) + 1)) selected.add(refKey(selectedRef));
  else { const key = refKey(item); if (selected.has(key)) selected.delete(key); else selected.add(key); }
  anchorIndex = index;
}
function selectedRefs() { return visibleRefs.value.filter(item => selected.has(refKey(item))); }
async function bookmarkSelected() {
  for (const ref of selectedRefs()) {
    const work = await services.client.work(ref);
    if (!work.bookmarked) { await services.client.bookmark(ref, true); remember({ ...work, bookmarked: true }); }
  }
}
async function replaceBookmarkTags() {
  const work = current.value;
  if (!work) return;
  const tags = [...new Set(bookmarkTags.value.split(/[,，\n]/).map(value => value.trim()).filter(Boolean))];
  await services.client.bookmark(work, true, tags, work.bookmarked ? undefined : privateBookmark.value);
  current.value = { ...work, bookmarked: true }; remember(current.value);
}
async function more() {
  if (paging.value || !hasNext.value || document.hidden) return;
  paging.value = true;
  try { const result = await services.client.list(location.href, listPage.value + 1); extraRefs.value.push(...result.refs); listPage.value++; hasNext.value = result.next; }
  catch (error) { notice.value = errorText(error); autoPage.value = false; }
  finally { paging.value = false; }
}
async function bookmark() { const work = current.value; if (!work) return; await services.client.bookmark(work, !work.bookmarked); current.value = { ...work, bookmarked: !work.bookmarked }; remember(current.value); }
async function follow() { const work = current.value; if (!work) return; await services.client.follow(work.userId, !work.following); current.value = { ...work, following: !work.following }; remember(current.value); }
function setCSV(field: 'users' | 'tags', event: Event) { draft.filter[field] = (event.target as HTMLTextAreaElement).value.split(/[,，\n]/).map(value => value.trim()).filter(Boolean); }
async function saveSettings() { await services.configure(structuredClone({ ...draft, filter: { ...draft.filter, users: [...draft.filter.users], tags: [...draft.filter.tags] } })); applyAds(); resetSiteFilter(); }
async function chooseDirectory() { await services.chooseDirectory(); draft.directory = !!services.settings.directory; }
async function syncCloud(choice?: 'local' | 'remote') {
  try {
    await services.setCloud({ ...cloud }); await services.sync(choice);
    syncConflict.value = false; Object.assign(draft, structuredClone(services.settings)); applyAds(); resetSiteFilter(); await refresh(); notice.value = '同步完成';
  } catch (error) { syncConflict.value = errorText(error).includes('冲突'); throw error; }
}
function applyAds() { adsStyle.textContent = '[data-pt-hidden]{display:none!important}[data-pt-following]{outline:2px solid #6997e6!important;outline-offset:2px}' + (draft.hideAds ? 'iframe[src*="ads.pixiv"],iframe[src*="doubleclick"],[data-testid="ad-container"]{display:none!important}' : ''); }
async function restore(event: Event) { const input = event.target as HTMLInputElement; const file = input.files?.[0]; if (file) await action(async () => { await services.restore(await file.text()); Object.assign(draft, structuredClone(services.settings)); applyAds(); resetSiteFilter(); await refresh(); }, '备份已导入'); input.value = ''; }
function stateLabel(state: Task['state']) { return ({ queued: '排队', running: '处理中', saving: '保存中', done: '完成', failed: '失败', paused: '暂停', uncertain: '待确认保存' })[state]; }
function date(at: number) { return new Date(at).toLocaleString(); }
function visibilityChange() {
  if (document.hidden) { clearPreload(); metadataController.abort(); for (const key of sitePending.keys()) siteAttempted.delete(key); siteController.abort(); cancelAnimationFrame(raf); raf = 0; }
  else { siteController = new AbortController(); startAnimation(); void loadWindow(); pumpSiteQueue(); }
}
watch([windowStart, search, sort], () => { void loadWindow(); });
watch(search, () => { windowStart.value = 0; });
watch(readKeys, resetSiteFilter);
watch(listEnd, node => { intersection?.disconnect(); if (node) intersection?.observe(node); });
onMounted(() => {
  document.head.append(adsStyle); applyAds();
  siteObserver = new IntersectionObserver(entries => {
    for (const entry of entries) if (entry.target instanceof HTMLAnchorElement) {
      if (entry.isIntersecting) siteVisible.add(entry.target); else siteVisible.delete(entry.target);
    }
    pumpSiteQueue();
  });
  stopCards = watchCards((items, changed) => {
    cards.value = items;
    if (changed) { closeViewer(); extraRefs.value = []; selected.clear(); windowStart.value = 0; listPage.value = Math.max(1, Number(new URL(location.href).searchParams.get('p')) || 1); hasNext.value = true; scheduleSource.value = location.href; metadataController.abort(); siteController.abort(); siteController = new AbortController(); siteAttempted.clear(); restoreSiteStyles(); }
    updateSiteCards(items);
    if (tab.value === 'works') void loadWindow();
  });
  unsubscribe = services.runtime.subscribe(() => { void refresh(); });
  intersection = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting) && autoPage.value && tab.value === 'works') void more(); }, { rootMargin: '120px' });
  document.addEventListener('pointermove', pointerMove, true);
  document.addEventListener('pointerout', pointerLeave);
  document.addEventListener('keydown', keydown, true);
  document.addEventListener('visibilitychange', visibilityChange);
  window.addEventListener('scroll', onScroll, true);
  void refresh();
  if (tab.value === 'settings') void services.cloud().then(value => { if (value) Object.assign(cloud, value); }).catch(error => { notice.value = errorText(error); });
});
onUnmounted(() => {
  alive = false; clearTimeout(readTimer); closeViewer(); metadataController.abort(); siteController.abort();
  stopCards?.(); unsubscribe?.(); intersection?.disconnect(); siteObserver?.disconnect(); restoreSiteStyles(); adsStyle.remove();
  document.removeEventListener('pointermove', pointerMove, true);
  document.removeEventListener('pointerout', pointerLeave);
  document.removeEventListener('keydown', keydown, true);
  document.removeEventListener('visibilitychange', visibilityChange);
  window.removeEventListener('scroll', onScroll, true);
});
</script>

<template>
  <div class="toolbox" :data-theme="draft.theme">
    <nav class="launcher" aria-label="Pixiv 工具箱">
      <button ref="toolbar" :class="{ active: tab === 'works' }" @click="setTab('works')">作品工作台</button>
      <button :class="{ active: tab === 'tasks' }" @click="setTab('tasks')">任务 <span v-if="tasks.some(task => task.state === 'running' || task.state === 'queued')" class="dot" /></button>
      <button :class="{ active: tab === 'history' }" @click="setTab('history')">历史</button>
      <button :class="{ active: tab === 'settings' }" @click="setTab('settings')">设置</button>
    </nav>
    <div v-if="notice" class="notice" role="status"><span>{{ notice }}</span><button aria-label="关闭提示" @click="notice = ''">×</button></div>

    <section v-if="tab" class="panel" :class="{ workbench: tab === 'works' }" :aria-label="tab === 'works' ? '作品工作台' : '工具箱面板'">
      <header class="panel-head"><h2>{{ { works: '作品工作台', tasks: '下载任务', history: '阅读历史', settings: '工具箱设置' }[tab] }}</h2><span class="subtle">{{ services.runtime.mode === 'extension' ? '浏览器扩展' : '用户脚本' }}</span><button aria-label="关闭面板" @click="setTab(null)">×</button></header>

      <div v-if="tab === 'works'" class="work-list">
        <button :disabled="!selectedRefs().length || busy" @click="action(bookmarkSelected, '选中作品已收藏；已有收藏保持不变')">收藏选中作品</button>
        <div class="list-controls"><input v-model="search" type="search" placeholder="搜索已载入的标题、作者、标签" aria-label="搜索作品"><label><input v-model="sort" type="checkbox">按收藏数排列</label><small>收藏数与筛选依据已载入的作品详情；每次载入 {{ windowSize }} 项。</small></div>
        <div class="row wrap"><button @click="windowRefs.forEach(item => selected.add(refKey(item)))">选中本页</button><button :disabled="!selected.size" @click="selected.clear()">清空</button><button class="primary" :disabled="!selected.size || busy" @click="action(() => services.enqueue(selectedRefs()), '已加入下载队列')">下载选中 ({{ selected.size }})</button></div>
        <div class="cards">
          <article v-for="item in windowRefs" :key="refKey(item)" class="work-card" :class="{ selected: selected.has(refKey(item)), following: works.get(refKey(item))?.following }">
            <button class="check" :aria-label="`选择作品 ${item.id}`" :aria-pressed="selected.has(refKey(item))" @click="select(item, $event)">{{ selected.has(refKey(item)) ? '✓' : '○' }}</button>
            <button class="card-open" @click="openWork(item)"><img v-if="works.get(refKey(item))?.thumb || cards.find(card => refKey(card.ref) === refKey(item))?.image?.src" :src="works.get(refKey(item))?.thumb || cards.find(card => refKey(card.ref) === refKey(item))?.image?.src" loading="lazy" alt=""><span class="card-copy"><strong>{{ works.get(refKey(item))?.title || `${item.kind === 'novel' ? '小说' : '作品'} #${item.id}` }}</strong><span>{{ works.get(refKey(item))?.userName || '载入详情中' }}</span><small>{{ works.get(refKey(item))?.bookmarkCount == null ? '收藏数未知' : `${works.get(refKey(item))?.bookmarkCount} 收藏` }}<b v-if="works.get(refKey(item))?.following"> · 已关注</b><b v-if="readKeys.has(refKey(item))"> · 已读</b></small></span></button>
          </article>
          <p v-if="!windowRefs.length" class="empty">当前页面没有符合条件的作品。可调整筛选，或在 Pixiv 打开作品列表。</p>
        </div>
        <div class="row wrap pager"><button :disabled="windowStart === 0" @click="windowStart = Math.max(0, windowStart - windowSize)">上一组</button><span>{{ visibleRefs.length ? windowStart + 1 : 0 }}–{{ Math.min(windowStart + windowSize, visibleRefs.length) }} / {{ visibleRefs.length }}</span><button :disabled="windowStart + windowSize >= visibleRefs.length" @click="windowStart += windowSize">下一组</button><button :disabled="!hasNext || paging" @click="more">{{ paging ? '载入中…' : hasNext ? '加载下一页' : '已到末页' }}</button></div>
        <label><input v-model="autoPage" type="checkbox">滚动到底部时自动载入下一页</label><div ref="listEnd" class="list-end" />
      </div>
      <div v-if="tab === 'works' && !visible" class="workspace-empty"><strong>从左侧选择作品</strong><p>方向键翻页 · J / K 切换作品 · F 全屏</p><small>在原站缩略图中央区域移动指针，可即时预览。</small></div>

      <div v-if="tab === 'tasks'" class="panel-body">
        <div class="row"><button :disabled="busy" @click="action(refresh)">刷新</button><span class="subtle">{{ tasks.length }} 个任务</span></div>
        <p v-if="!tasks.length" class="empty">选择作品后可加入下载队列。</p>
        <article v-for="task in tasks" :key="task.id" class="task"><div class="row"><strong>{{ task.title || `作品 #${task.ref.id}` }}</strong><span class="badge">{{ stateLabel(task.state) }}</span></div><progress :value="task.progress" :max="Math.max(1, task.total)" /><small>{{ task.progress }} / {{ task.total }} · {{ date(task.created) }}</small><p v-if="task.error" class="error">{{ task.error }}</p><div class="row wrap"><button v-if="['queued','running'].includes(task.state)" :disabled="busy" @click="action(() => services.taskAction(task.id, 'pause'))">暂停</button><button v-if="['paused','failed'].includes(task.state)" :disabled="busy" @click="action(() => services.taskAction(task.id, 'resume'))">继续 / 重试</button><button v-if="task.state === 'uncertain'" :disabled="busy" @click="action(() => services.taskAction(task.id, 'confirm'))">确认文件已保存</button><button :disabled="busy || task.state === 'saving'" @click="action(() => services.taskAction(task.id, 'remove'))">移除任务</button></div></article>
      </div>

      <div v-if="tab === 'history'" class="panel-body"><p class="subtle">阅读进度随作品保存。点击继续阅读。</p><p v-if="!histories.length" class="empty">尚无阅读记录。</p><button v-for="reading in histories.slice(0, 200)" :key="`${reading.account}:${refKey(reading.ref)}`" class="history-row" @click="openWork(reading.ref)"><img v-if="reading.thumb" :src="reading.thumb" loading="lazy" alt=""><span><strong>{{ reading.title }}</strong><small>{{ reading.ref.kind === 'novel' ? `${Math.round(reading.position * 100)}%` : `第 ${reading.page + 1} 页` }} · {{ date(reading.at) }}</small></span></button><small v-if="histories.length > 200">显示最近 200 项，完整记录包含在备份中。</small></div>

      <form v-if="tab === 'settings'" class="panel-body settings" @submit.prevent="action(saveSettings, '设置已保存')">
        <fieldset><legend>浏览与阅读</legend><label><input v-model="draft.hover" type="checkbox">开启缩略图悬停预览</label><label>中央触发区域：宽高各 {{ draft.hoverRatio }}%<input v-model.number="draft.hoverRatio" type="range" min="1" max="100"></label><label>主题<select v-model="draft.theme"><option value="auto">跟随系统</option><option value="light">浅色</option><option value="dark">深色</option></select></label><label>邻近预载作品数<input v-model.number="draft.preload" type="number" min="0" max="4"></label><label><input v-model="draft.hideAds" type="checkbox">隐藏已识别广告位</label></fieldset>
        <fieldset><legend>下载与文件</legend><label>文件名模板<input v-model="draft.filename" required placeholder="{id}_{title}_{page}"></label><small>可用字段：{artist}、{title}、{id}、{page}。页码从 0 开始，斜线可创建子目录。</small><label>子目录<input v-model="draft.folder" placeholder="Pixiv"></label><label>动图格式<select v-model="draft.animationFormat"><option value="zip">原始帧 ZIP</option><option value="gif">GIF</option><option value="mp4">MP4</option><option value="webm">WebM</option></select></label><label>小说格式<select v-model="draft.novelFormat"><option value="txt">TXT</option><option value="epub">EPUB</option></select></label><label><input v-model="draft.mangaZip" type="checkbox">多页作品打包 ZIP</label><label><input v-model="draft.metadata" type="checkbox">附带作品元数据</label><label>并发下载数<input v-model.number="draft.concurrency" type="number" min="1" max="6"></label><button type="button" :disabled="busy" @click="action(chooseDirectory, '目录授权已更新')">选择保存目录</button><button v-if="draft.directory" type="button" :disabled="busy" @click="action(async () => { draft.directory = false; await saveSettings() }, '已恢复浏览器默认下载目录')">恢复浏览器默认目录</button><small>格式编码与目录能力取决于当前浏览器；不支持时任务会显示具体原因。</small></fieldset>
        <fieldset><legend>筛选与黑名单</legend><label>最低收藏数<input v-model.number="draft.filter.minBookmarks" type="number" min="0"></label><label><input v-model="draft.filter.hideBookmarked" type="checkbox">隐藏已收藏</label><label><input v-model="draft.filter.hideFollowing" type="checkbox">隐藏已关注作者</label><label><input v-model="draft.filter.hideRead" type="checkbox">隐藏已读</label><label><input v-model="draft.filter.hideAdult" type="checkbox">隐藏成人内容</label><label><input v-model="draft.filter.hideAI" type="checkbox">隐藏 AI 作品</label><label>屏蔽作者 ID（逗号或换行分隔）<textarea :value="draft.filter.users.join('\n')" rows="3" @input="setCSV('users', $event)" /></label><label>屏蔽标签（完整标签匹配）<textarea :value="draft.filter.tags.join('\n')" rows="3" @input="setCSV('tags', $event)" /></label></fieldset>
        <fieldset><legend>数据、定时与云同步</legend><div class="row wrap"><button type="button" :disabled="busy" @click="action(async () => services.runtime.save(await services.backup(), 'pixiv-toolbox-backup.json'))">导出备份</button><label class="file-button">导入备份<input type="file" accept="application/json,.json" @change="restore"></label></div><p class="subtle">备份包含设置、阅读记录和下载历史，不含凭据。</p><label>定时下载来源<input v-model="scheduleSource" type="url" placeholder="Pixiv 列表页面地址"></label><div class="row"><label>间隔（分钟）<input v-model.number="scheduleEvery" type="number" min="5"></label><label>每次上限<input v-model.number="scheduleLimit" type="number" min="1" max="1000"></label></div><button type="button" :disabled="busy" @click="action(async () => { await saveSettings(); await services.schedule(scheduleSource, scheduleEvery, scheduleLimit); await refresh() }, '定时任务已添加')">添加定时任务</button><small>只在运行环境活跃且已登录时执行；关闭浏览器后不会在后台服务器运行。</small><article v-for="item in schedules" :key="item.id" class="schedule"><span>{{ item.source }}</span><small>每 {{ item.everyMinutes }} 分钟 · 下次 {{ date(item.next) }}</small><button type="button" :disabled="busy" @click="action(async () => { await services.removeSchedule(item.id); await refresh() })">删除</button></article><label>WebDAV 地址<input v-model="cloud.url" type="url" placeholder="https://…"></label><label>用户名<input v-model="cloud.username" autocomplete="off"></label><label>密码<input v-model="cloud.password" type="password" autocomplete="new-password"></label><label><input v-model="cloud.upload" type="checkbox">下载完成后上传文件</label><div class="row wrap"><button type="button" :disabled="busy" @click="action(() => services.setCloud({ ...cloud }), '云设置已保存')">保存云设置</button><button type="button" :disabled="busy || !cloud.url" @click="action(() => syncCloud())">立即同步</button></div><div v-if="syncConflict" class="conflict"><p>本机与云端设置有冲突。请选择这次保留哪一份设置；阅读进度仍按较新的记录合并。</p><div class="row wrap"><button type="button" :disabled="busy" @click="action(() => syncCloud('local'))">保留本机设置并同步</button><button type="button" :disabled="busy" @click="action(() => syncCloud('remote'))">使用云端设置并同步</button></div></div></fieldset>
        <button class="primary save-settings" :disabled="busy" type="submit">{{ busy ? '处理中…' : '保存设置' }}</button>
      </form>
    </section>

    <section v-if="visible" ref="viewer" class="viewer" :class="{ docked: tab === 'works' }" :style="viewerStyle" role="dialog" :aria-label="current?.title || '作品查看器'" tabindex="-1" @pointerdown="pinned = true">
      <details v-if="current" class="viewer-actions"><summary>收藏标签与选页下载</summary><div class="row wrap"><label>新的收藏标签<input v-model="bookmarkTags" placeholder="以逗号分隔"></label><label v-if="!current.bookmarked"><input v-model="privateBookmark" type="checkbox">私密收藏</label><button :disabled="busy" @click="action(replaceBookmarkTags, '收藏标签已保存')">{{ current.bookmarked ? '替换收藏标签' : '按这些标签收藏' }}</button><small v-if="current.bookmarked">保存将替换原有收藏标签，并保持原来的公开／私密状态。</small></div><div v-if="current.pages.length > 1" class="row wrap"><label>下载页码<input v-model="chosenPages" placeholder="例如 1,3-5"></label><button :disabled="busy || !chosenPages.trim()" @click="action(() => services.enqueue([current!], { pages: parsePages(chosenPages, current!.pages.length) }), '指定页面已加入队列')">下载指定页</button></div></details>
      <header class="viewer-head"><div><h2>{{ current?.title || (loading ? '正在载入作品…' : '作品查看器') }}</h2><details v-if="current" class="author-menu"><summary>{{ current.userName }} <span v-if="current.following">· 已关注</span></summary><div class="menu"><a :href="`https://www.pixiv.net/users/${current.userId}`" target="_blank" rel="noopener noreferrer">作者主页</a><button :disabled="busy" @click="action(follow)">{{ current.following ? '取消关注' : '关注作者' }}</button><button :disabled="busy || !current.avatar" @click="action(() => services.enqueue([current!], { asset: 'avatar' }), '头像已加入下载队列')">下载头像</button><button :disabled="busy || !current.cover" @click="action(() => services.enqueue([current!], { asset: 'cover' }), '封面已加入下载队列')">下载封面</button><button @click="draft.filter.users.push(current.userId); action(saveSettings, '作者已加入黑名单')">屏蔽作者</button></div></details></div><button v-if="!pinned" @click="pinned = true; viewer?.focus()">固定</button><button aria-label="关闭查看器" @click="closeViewer">×</button></header>
      <div v-if="loading" class="empty grow" role="status">正在读取作品详情…</div><div v-else-if="viewerError" class="empty grow error">{{ viewerError }}<button @click="retryWork">重试</button></div>
      <template v-if="current">
        <div v-if="current.kind === 'novel'" class="novel-controls row wrap"><label>字号<input v-model.number="fontSize" type="range" min="14" max="32"></label><label>行距<input v-model.number="lineHeight" type="range" min="1.3" max="2.6" step="0.1"></label><span>{{ Math.round(progress * 100) }}%</span></div>
        <div v-if="current.kind === 'novel'" ref="novelBody" class="novel-body" :style="{ fontSize: `${fontSize}px`, lineHeight }" @scroll="novelScroll"><p>{{ current.text || '该作品没有可读取的正文。' }}</p></div>
        <div v-else class="stage" @pointerdown="startPan" @pointermove="drag" @pointerup="endPan" @pointercancel="endPan" @wheel.prevent="changeZoom(zoom * ($event.deltaY > 0 ? 0.9 : 1.1))"><canvas v-if="animation" ref="canvas" :style="imageStyle" aria-label="动图画布" /><img v-else-if="pageImage" :src="pageImage.regular || pageImage.original" :style="imageStyle" draggable="false" :alt="`${current.title} 第 ${page + 1} 页`"><p v-if="animationLoading" class="stage-message">正在解码动图…</p><p v-if="animationError" class="stage-message error">{{ animationError }}</p></div>
        <input v-if="current.kind === 'novel'" class="novel-progress" aria-label="阅读进度" type="range" min="0" max="1" step="0.001" :value="progress" @input="seekNovel">
        <div v-if="animation" class="row wrap animation-controls"><button @click="stepFrame(-1)">上一帧</button><button @click="playing = !playing">{{ playing ? '暂停' : '播放' }}</button><button @click="stepFrame(1)">下一帧</button><span>{{ frame + 1 }}/{{ animation.images.length }}</span><label>速度<select v-model.number="speed"><option :value="0.25">0.25×</option><option :value="0.5">0.5×</option><option :value="1">1×</option><option :value="1.5">1.5×</option><option :value="2">2×</option></select></label></div>
        <div v-if="current.pages.length > 1" class="thumbnails"><button v-for="(image, index) in thumbnailPages" :key="image.original" :class="{ active: page === thumbnailStart + index }" :aria-label="`第 ${thumbnailStart + index + 1} 页`" @click="movePage(thumbnailStart + index - page)"><img :src="image.regular" loading="lazy" alt=""><span>{{ thumbnailStart + index + 1 }}</span></button></div>
        <footer class="viewer-footer"><div class="row wrap"><template v-if="current.kind !== 'novel'"><button :disabled="page === 0" @click="movePage(-1)">上一页</button><span>{{ page + 1 }}/{{ current.pages.length }}</span><button :disabled="page >= current.pages.length - 1" @click="movePage(1)">下一页</button><button @click="changeZoom(zoom / 1.2)">−</button><button @click="resetTransform">{{ Math.round(zoom * 100) }}%</button><button @click="changeZoom(zoom * 1.2)">＋</button><button @click="rotation = (rotation + 90) % 360">旋转</button></template><button @click="fullscreen">全屏</button></div><div class="row wrap"><button :disabled="busy" @click="action(bookmark)">{{ current.bookmarked ? '取消收藏' : '收藏' }}</button><button class="primary" :disabled="busy" @click="action(() => services.enqueue([current!]), '已加入下载队列')">下载作品</button><button v-if="current.pages.length > 1" :disabled="busy" @click="action(() => services.enqueue([current!], { pages: [page] }), '当前页已加入下载队列')">下载本页</button><a :href="current.kind === 'novel' ? `https://www.pixiv.net/novel/show.php?id=${current.id}` : `https://www.pixiv.net/artworks/${current.id}`" target="_blank" rel="noopener noreferrer">原作</a><span class="subtle">{{ current.bookmarkCount == null ? '收藏数未知' : `${current.bookmarkCount} 收藏` }}</span></div></footer>
      </template>
    </section>
  </div>
</template>
