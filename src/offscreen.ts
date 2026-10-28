import { createServices, startRunner } from './services';
import { decode, extensionRuntime, localExtensionRuntime } from './runtime';

const bridge = extensionRuntime();
const runtime = localExtensionRuntime(bridge.save, bridge.notify);
runtime.subscribe = bridge.subscribe;
void createServices(runtime).then(startRunner);
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== chrome.runtime.id || message?.app !== 'pixiv-toolbox' || message.op !== 'blob') return;
  const [body, type, filename, conflict, receipt] = message.args;
  const url = URL.createObjectURL(new Blob([new Uint8Array(decode(body))], { type }));
  void bridge.save(url, filename, conflict, receipt).then(() => reply({ ok: true }), error => reply({ ok: false, error: error.message })).finally(() => URL.revokeObjectURL(url));
  return true;
});
