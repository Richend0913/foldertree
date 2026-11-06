import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';

// Boots the real app.js against the few DOM features its start-up path touches.
class FakeElement {
  dataset = {};
  hidden = false;
  disabled = false;
  value = '';
  classList = new Set();
  listeners = {};
  options = [];

  constructor() {
    this.classList.remove = this.classList.delete;
  }

  addEventListener(type) {
    this.listeners[type] = true;
  }

  append() {}

  add(option) {
    this.options.push(option);
  }
}

async function boot({ kofiUrl, canChoose = true, canDrop = true }) {
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, new FakeElement());
    return elements.get(id);
  };
  if (canChoose) element('folderInput').webkitdirectory = true;

  const kofi = new FakeElement();
  kofi.dataset.href = 'KOFI_URL';
  const sponsor = new FakeElement();
  sponsor.dataset.href = 'SPONSOR_URL';

  const body = new FakeElement();
  const strings = JSON.parse(readFileSync('strings/en.json', 'utf8'));
  if (kofiUrl !== undefined) strings.KOFI_URL = kofiUrl;

  globalThis.document = {
    body,
    title: '',
    getElementById: element,
    createElement: () => new FakeElement(),
    querySelectorAll: (selector) => (selector === '[data-href]' ? [kofi, sponsor] : []),
  };
  globalThis.window = {
    addEventListener() {},
    matchMedia: () => ({ matches: canDrop }),
  };
  globalThis.DataTransferItem = class {
    webkitGetAsEntry() {}
  };
  globalThis.Option = class {};
  globalThis.fetch = async () => ({ ok: true, json: async () => strings });

  // A new query string gives each boot its own copy of the module state.
  boot.count = (boot.count ?? 0) + 1;
  await import(`../src/app.js?boot=${boot.count}`);
  while (!body.classList.has('is-ready')) {
    assert.equal(elements.get('loadError')?.hidden, undefined, 'app failed to start');
    await nextTurn();
  }
  return { element, kofi, sponsor, strings };
}

test('hides the Ko-fi link while the URL is the placeholder', async () => {
  const { kofi, sponsor, strings } = await boot({});
  assert.equal(kofi.hidden, true);
  assert.equal('href' in kofi, false);
  assert.equal(sponsor.hidden, false);
  assert.equal(sponsor.href, strings.SPONSOR_URL);
});

test('hides the Ko-fi link while the URL is empty', async () => {
  const { kofi } = await boot({ kofiUrl: '' });
  assert.equal(kofi.hidden, true);
  assert.equal('href' in kofi, false);
});

test('shows the Ko-fi link once a real URL is set', async () => {
  const { kofi } = await boot({ kofiUrl: 'https://ko-fi.com/richend' });
  assert.equal(kofi.hidden, false);
  assert.equal(kofi.href, 'https://ko-fi.com/richend');
});

test('keeps drop working without folder selection', async () => {
  const { element } = await boot({ canChoose: false });
  assert.equal(element('choose').hidden, true);
  assert.equal(element('dropHint').hidden, false);
  assert.equal(element('picker').listeners.drop, true);
  assert.equal(element('error').textContent, undefined);
});

test('keeps folder selection working without drop', async () => {
  const { element } = await boot({ canDrop: false });
  assert.equal(element('choose').hidden, false);
  assert.equal(element('dropHint').hidden, true);
  assert.equal(element('picker').listeners.drop, undefined);
  assert.equal(element('error').textContent, undefined);
});

test('reports when neither input method is available', async () => {
  const { element, strings } = await boot({ canChoose: false, canDrop: false });
  assert.equal(element('error').textContent, strings.errorUnsupported);
  assert.equal(element('error').hidden, false);
});
