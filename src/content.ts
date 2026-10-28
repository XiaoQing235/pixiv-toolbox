import { extensionRuntime } from './runtime';
import { createServices } from './services';
import { mount } from './ui/mount';

void createServices(extensionRuntime()).then(mount).catch(error => console.error('[Pixiv Toolbox]', error.message));
