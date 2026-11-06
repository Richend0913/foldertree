import {
  DEFAULT_EXCLUDES,
  DEFAULT_PATTERNS,
  MAX_READ,
  createFilter,
  parsePatterns,
  renderTree,
  treeFromEntry,
  treeFromPaths,
  wrapInFence,
} from './tree.js';
import { isConfiguredUrl } from './links.js';

const MAX_DEPTH_CHOICE = 10;
const DOWNLOAD_NAME = 'folder-tree.txt';
const COPY_MESSAGE_MS = 2500;
const PATTERN_DEBOUNCE_MS = 250;
const REVOKE_DELAY_MS = 1000;

const $ = (id) => document.getElementById(id);

let strings = {};
let source = null; // { kind: 'paths', paths, total } or { kind: 'entry', entry }
let scanned = null;
let outputText = '';
let scanId = 0;
let patternTimer;
let copyTimer;

const count = (value) => value.toLocaleString('en-US');

function t(key, values = {}) {
  return strings[key].replace(/\{(\w+)\}/g, (_, name) => values[name]);
}

const plural = (value, one, other) => t(value === 1 ? one : other, { count: count(value) });

function applyStrings() {
  document.title = t('pageTitle');
  for (const element of document.querySelectorAll('[data-i18n]')) {
    element.textContent = t(element.dataset.i18n);
  }
  for (const element of document.querySelectorAll('[data-href]')) {
    const url = strings[element.dataset.href];
    if (isConfiguredUrl(url)) element.href = url;
    else element.hidden = true;
  }
}

function buildOptions() {
  const list = $('excludeList');
  for (const name of DEFAULT_EXCLUDES) {
    const label = document.createElement('label');
    label.className = 'check';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = true;
    input.value = name;
    input.dataset.exclude = '';
    const text = document.createElement('code');
    text.textContent = name;
    label.append(input, text);
    list.append(label);
  }

  const depth = $('depth');
  const unlimited = new Option(t('depthUnlimited'), '');
  depth.add(unlimited);
  for (let level = 1; level <= MAX_DEPTH_CHOICE; level += 1) {
    depth.add(new Option(String(level), String(level)));
  }

  $('patterns').value = DEFAULT_PATTERNS;
}

function readFilterOptions() {
  const checked = document.querySelectorAll('[data-exclude]:checked');
  return {
    excludes: [...checked].map((input) => input.value),
    patterns: parsePatterns($('patterns').value),
    showHidden: $('showHidden').checked,
  };
}

function showError(message) {
  $('error').textContent = message;
  $('error').hidden = !message;
}

function setHasResult(hasResult) {
  $('emptyState').hidden = hasResult;
  $('resultBody').hidden = !hasResult;
  $('tip').hidden = !hasResult;
}

function clearResult() {
  scanned = null;
  outputText = '';
  $('emptyState').textContent = t('emptyState');
  setHasResult(false);
}

function describeCutoff({ truncatedBy, shownFiles, shownFolders }) {
  const { totalFiles, totalFolders } = scanned;
  if (truncatedBy === 'files') {
    const values = { shown: count(shownFiles), total: count(totalFiles) };
    return { line: t('treeTruncatedLine', values), notice: t('noticeFileLimit', values) };
  }
  const values = {
    shown: count(shownFiles + shownFolders),
    total: count(totalFiles + totalFolders),
  };
  return { line: t('treeNodeLimitLine', values), notice: t('noticeNodeLimit', values) };
}

function renderOutput() {
  if (!scanned) return;
  const { root, totalFiles, readLimitHit, unreadable } = scanned;
  const maxDepth = $('depth').value ? Number($('depth').value) : Infinity;
  const style = document.querySelector('input[name="style"]:checked').value;
  const tree = renderTree(root, {
    style,
    maxDepth,
    cutoffLine: (cut) => describeCutoff(cut).line,
  });

  const notices = [];
  if (tree.truncated) notices.push(describeCutoff(tree).notice);
  if (readLimitHit) notices.push(t('noticeReadLimit', { limit: count(MAX_READ) }));
  if (unreadable > 0) notices.push(t('noticeUnreadable', { count: count(unreadable) }));

  outputText = tree.text;
  $('preview').textContent = tree.text;
  $('stats').textContent =
    tree.shownFiles === totalFiles
      ? `${plural(tree.shownFolders, 'folderOne', 'folderOther')}, ${plural(totalFiles, 'fileOne', 'fileOther')}`
      : t('statsPartial', {
          folders: plural(tree.shownFolders, 'folderOne', 'folderOther'),
          shown: count(tree.shownFiles),
          total: count(totalFiles),
        });
  $('notices').textContent = notices.join(' ');
  $('notices').hidden = notices.length === 0;
  setHasResult(true);
}

async function scan() {
  if (!source) return;
  scanId += 1;
  const id = scanId;
  const options = {
    maxRead: MAX_READ,
    isCancelled: () => id !== scanId,
    onProgress: (read) => {
      const target = $('resultBody').hidden ? $('emptyState') : $('stats');
      target.textContent = t('reading', { count: count(read) });
    },
  };
  const isExcluded = createFilter(readFilterOptions());
  $('copy').disabled = true;
  $('download').disabled = true;

  try {
    const result =
      source.kind === 'paths'
        ? await treeFromPaths(source.paths, isExcluded, options)
        : await treeFromEntry(source.entry, isExcluded, options);
    if (id !== scanId || !result) return;
    if (source.kind === 'paths' && source.total > source.paths.length) result.readLimitHit = true;
    scanned = result;
    renderOutput();
  } catch {
    if (id !== scanId) return;
    clearResult();
    showError(t('errorRead'));
  }
  $('copy').disabled = false;
  $('download').disabled = false;
}

function useSource(nextSource) {
  showError('');
  source = nextSource;
  scan();
}

function onFilesChosen(event) {
  const { files } = event.target;
  const total = files.length;
  const paths = [];
  for (let index = 0; index < Math.min(total, MAX_READ); index += 1) {
    paths.push(files[index].webkitRelativePath);
  }
  // Reset so that choosing the same folder again fires `change`.
  event.target.value = '';

  if (total === 0) {
    source = null;
    clearResult();
    showError(t('errorEmpty'));
    return;
  }
  useSource({ kind: 'paths', paths, total });
}

function onDrop(event) {
  event.preventDefault();
  $('picker').classList.remove('is-over');

  // getAsEntry only works during the event, so collect before any await.
  const entries = [...event.dataTransfer.items]
    .filter((item) => item.kind === 'file')
    .map((item) => item.webkitGetAsEntry())
    .filter(Boolean);

  if (entries.length > 1) {
    showError(t('errorOneFolder'));
  } else if (entries.length === 0 || !entries[0].isDirectory) {
    showError(t('errorNotFolder'));
  } else {
    useSource({ kind: 'entry', entry: entries[0] });
  }
}

function supportsDrop() {
  return (
    typeof DataTransferItem !== 'undefined' &&
    'webkitGetAsEntry' in DataTransferItem.prototype &&
    window.matchMedia('(hover: hover) and (pointer: fine)').matches
  );
}

function setUpDrop() {
  const picker = $('picker');
  picker.classList.add('can-drop');

  // A drop that misses the zone would otherwise navigate away from the page.
  window.addEventListener('dragover', (event) => event.preventDefault());
  window.addEventListener('drop', (event) => event.preventDefault());

  picker.addEventListener('dragover', (event) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    picker.classList.add('is-over');
  });
  picker.addEventListener('dragleave', (event) => {
    if (!picker.contains(event.relatedTarget)) picker.classList.remove('is-over');
  });
  picker.addEventListener('drop', onDrop);
}

// Each input method is checked on its own, so losing one keeps the other.
function setUpInputs() {
  const canChoose = 'webkitdirectory' in $('folderInput');
  const canDrop = supportsDrop();
  $('choose').hidden = !canChoose;
  $('dropHint').hidden = !canDrop;
  if (canDrop) setUpDrop();
  if (!canChoose && !canDrop) showError(t('errorUnsupported'));
}

function showCopyMessage(message) {
  clearTimeout(copyTimer);
  $('copyStatus').textContent = message;
  copyTimer = setTimeout(() => {
    $('copyStatus').textContent = '';
  }, COPY_MESSAGE_MS);
}

async function copyTree() {
  const text = $('fence').checked ? wrapInFence(outputText) : outputText;
  try {
    await navigator.clipboard.writeText(text);
    showCopyMessage(t('copied'));
  } catch {
    showCopyMessage(t('copyFailed'));
  }
}

function downloadTree() {
  const blob = new Blob([`${outputText}\n`], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = DOWNLOAD_NAME;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), REVOKE_DELAY_MS);
}

function bindEvents() {
  $('choose').addEventListener('click', () => $('folderInput').click());
  $('folderInput').addEventListener('change', onFilesChosen);

  $('excludeList').addEventListener('change', scan);
  $('showHidden').addEventListener('change', scan);
  $('patterns').addEventListener('input', () => {
    clearTimeout(patternTimer);
    patternTimer = setTimeout(scan, PATTERN_DEBOUNCE_MS);
  });

  $('depth').addEventListener('change', renderOutput);
  for (const radio of document.querySelectorAll('input[name="style"]')) {
    radio.addEventListener('change', renderOutput);
  }

  $('copy').addEventListener('click', copyTree);
  $('download').addEventListener('click', downloadTree);
}

async function start() {
  const response = await fetch('strings/en.json');
  if (!response.ok) throw new Error(`strings/en.json: ${response.status}`);
  strings = await response.json();

  applyStrings();
  buildOptions();
  bindEvents();
  setUpInputs();
  document.body.classList.add('is-ready');
}

start().catch(() => {
  $('loadError').hidden = false;
});
