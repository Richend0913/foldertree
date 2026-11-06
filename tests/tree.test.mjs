import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  DEFAULT_EXCLUDES,
  MAX_FILES,
  MAX_NODES,
  createFilter,
  parsePatterns,
  renderTree,
  treeFromEntry,
  treeFromPaths,
  wrapInFence,
} from '../src/tree.js';
import { isConfiguredUrl } from '../src/links.js';

const keepAll = createFilter();

const render = async (paths, filter = keepAll, options) =>
  renderTree((await treeFromPaths(paths, filter)).root, options).text;

// Mimics FileSystemEntry, returning at most `batchSize` children per read.
function fakeDir(name, children, batchSize = 2, onRead = () => {}) {
  return {
    name,
    isDirectory: true,
    createReader() {
      let offset = 0;
      return {
        readEntries(resolve) {
          onRead();
          const batch = children.slice(offset, offset + batchSize);
          offset += batchSize;
          resolve(batch);
        },
      };
    },
  };
}
const fakeFile = (name) => ({ name, isDirectory: false });

test('renders a Unicode tree with folders first', async () => {
  const text = await render(['app/README.md', 'app/src/index.js', 'app/src/lib/a.js', 'app/LICENSE']);
  assert.equal(text, [
    'app/',
    '├── src/',
    '│   ├── lib/',
    '│   │   └── a.js',
    '│   └── index.js',
    '├── LICENSE',
    '└── README.md',
  ].join('\n'));
});

test('renders an ASCII tree', async () => {
  const text = await render(['app/src/a.js', 'app/b.js'], keepAll, { style: 'ascii' });
  assert.equal(text, ['app/', '|-- src/', '|   `-- a.js', '`-- b.js'].join('\n'));
});

test('sorts numbers naturally', async () => {
  const text = await render(['r/f10.txt', 'r/f2.txt']);
  assert.ok(text.indexOf('f2.txt') < text.indexOf('f10.txt'));
});

test('default exclusions drop folders and their contents', async () => {
  const filter = createFilter({ excludes: DEFAULT_EXCLUDES });
  const text = await render(['app/node_modules/x/i.js', 'app/.git/HEAD', 'app/index.js'], filter);
  assert.equal(text, 'app/\n└── index.js');
});

test('the selected root is never excluded', async () => {
  const filter = createFilter({ excludes: DEFAULT_EXCLUDES, showHidden: false });
  assert.equal(await render(['dist/a.js'], filter), 'dist/\n└── a.js');
  assert.equal(await render(['.config/a.js'], filter), '.config/\n└── a.js');
});

test('hidden files follow the showHidden option', async () => {
  const paths = ['app/.env', 'app/a.js'];
  assert.match(await render(paths, createFilter({ showHidden: true })), /\.env/);
  assert.doesNotMatch(await render(paths, createFilter({ showHidden: false })), /\.env/);
});

test('custom patterns match exact names and wildcards', async () => {
  const patterns = parsePatterns(' .DS_Store, *.log ,tmp/, a?c.txt, ');
  assert.deepEqual(patterns, ['.DS_Store', '*.log', 'tmp', 'a?c.txt']);
  const text = await render(
    ['app/.DS_Store', 'app/x.log', 'app/tmp/y', 'app/abc.txt', 'app/keep.txt', 'app/xlog'],
    createFilter({ patterns }),
  );
  assert.equal(text, 'app/\n├── keep.txt\n└── xlog');
});

test('depth limit keeps folders but hides what is below them', async () => {
  const { root, totalFiles } = await treeFromPaths(['app/a/b/c.txt', 'app/d.txt'], keepAll);
  const tree = renderTree(root, { maxDepth: 1 });
  assert.equal(tree.text, 'app/\n├── a/\n└── d.txt');
  assert.equal(tree.shownFiles, 1);
  assert.equal(totalFiles, 2);
});

test('stops at the file limit and reports it', async () => {
  const paths = Array.from({ length: MAX_FILES + 3 }, (_, index) => `app/f${index}.txt`);
  const { root, totalFiles } = await treeFromPaths(paths, keepAll);
  const tree = renderTree(root);
  assert.equal(tree.shownFiles, MAX_FILES);
  assert.equal(totalFiles, MAX_FILES + 3);
  assert.equal(tree.truncated, true);
});

test('does not report truncation at exactly the file limit', async () => {
  const paths = Array.from({ length: MAX_FILES }, (_, index) => `app/f${index}.txt`);
  assert.equal(renderTree((await treeFromPaths(paths, keepAll)).root).truncated, false);
});

test('stops reading paths at the read limit', async () => {
  const result = await treeFromPaths(['a/1', 'a/2', 'a/3'], keepAll, { maxRead: 2 });
  assert.equal(result.read, 2);
  assert.equal(result.readLimitHit, true);
  assert.equal(result.totalFiles, 2);
});

test('marks a file cut-off as the last child of the folder it happens in', async () => {
  const { root } = await treeFromPaths(['app/a/1.txt', 'app/a/2.txt', 'app/a/3.txt', 'app/b/4.txt'], keepAll);
  assert.equal(renderTree(root, { maxFiles: 2, cutoffLine: () => '... cut' }).text, [
    'app/',
    '└── a/',
    '    ├── 1.txt',
    '    ├── 2.txt',
    '    └── ... cut',
  ].join('\n'));
});

test('a flat cut-off closes the list in both styles', async () => {
  const { root } = await treeFromPaths(['app/1', 'app/2', 'app/3'], keepAll);
  assert.equal(renderTree(root, { maxFiles: 1 }).text, 'app/\n├── 1\n└── ...');
  assert.equal(renderTree(root, { maxFiles: 1, style: 'ascii' }).text, 'app/\n|-- 1\n`-- ...');
});

test('the cut-off marker receives the final counts', async () => {
  const { root } = await treeFromPaths(['app/d/1', 'app/d/2'], keepAll);
  const cuts = [];
  const tree = renderTree(root, {
    maxFiles: 1,
    cutoffLine: (cut) => {
      cuts.push(cut);
      return '...';
    },
  });
  assert.deepEqual(cuts, [{ truncatedBy: 'files', shownFiles: 1, shownFolders: 1 }]);
  assert.equal(tree.truncatedBy, 'files');
});

test('limits shown items so empty folders cannot bloat the tree', async () => {
  const folders = Array.from({ length: 5 }, (_, index) => fakeDir(`d${index}`, []));
  const { root, totalFolders, totalFiles } = await treeFromEntry(fakeDir('app', folders), keepAll);
  assert.equal(totalFolders, 5);
  assert.equal(totalFiles, 0);

  const tree = renderTree(root, { maxNodes: 3 });
  assert.equal(tree.text, 'app/\n├── d0/\n├── d1/\n├── d2/\n└── ...');
  assert.equal(tree.shownFolders, 3);
  assert.equal(tree.truncatedBy, 'nodes');
  assert.equal(renderTree(root, { maxNodes: 5 }).truncated, false);
});

test('the default item limit still allows the full file limit', () => {
  assert.ok(MAX_NODES > MAX_FILES);
});

test('walks dropped folders across read batches and keeps empty folders', async () => {
  const entry = fakeDir('app', [
    fakeFile('a.txt'),
    fakeFile('b.txt'),
    fakeFile('c.txt'),
    fakeDir('empty', []),
    fakeDir('src', [fakeFile('d.txt')]),
  ]);
  const { root, totalFiles, totalFolders } = await treeFromEntry(entry, keepAll);
  assert.equal(totalFiles, 4);
  assert.equal(totalFolders, 2);
  assert.match(renderTree(root).text, /empty\//);
});

test('prunes excluded folders without opening them', async () => {
  const entry = fakeDir('app', [
    {
      name: 'node_modules',
      isDirectory: true,
      createReader() {
        throw new Error('excluded folder was opened');
      },
    },
    fakeFile('a.txt'),
  ]);
  const { totalFiles } = await treeFromEntry(entry, createFilter({ excludes: ['node_modules'] }));
  assert.equal(totalFiles, 1);
});

test('counts folders that fail to read', async () => {
  const broken = {
    name: 'locked',
    isDirectory: true,
    createReader: () => ({ readEntries: (_, reject) => reject(new Error('denied')) }),
  };
  const { unreadable, totalFolders } = await treeFromEntry(fakeDir('app', [broken]), keepAll);
  assert.equal(unreadable, 1);
  assert.equal(totalFolders, 1);
});

test('stops reading entries at the read limit', async () => {
  const entry = fakeDir('app', [fakeFile('a'), fakeFile('b'), fakeFile('c')]);
  const { read, readLimitHit } = await treeFromEntry(entry, keepAll, { maxRead: 2 });
  assert.equal(read, 2);
  assert.equal(readLimitHit, true);
});

test('takes only what fits from a batch and reads no further', async () => {
  const files = Array.from({ length: 100 }, (_, index) => fakeFile(`f${index}`));
  let reads = 0;
  const entry = fakeDir('app', files, 4, () => {
    reads += 1;
  });
  const { read, readLimitHit, totalFiles } = await treeFromEntry(entry, keepAll, { maxRead: 6 });
  assert.equal(read, 6);
  assert.equal(totalFiles, 6);
  assert.equal(readLimitHit, true);
  assert.equal(reads, 2);
});

test('does not request another batch once a batch ends on the limit', async () => {
  let reads = 0;
  const files = [fakeFile('a'), fakeFile('b'), fakeFile('c'), fakeFile('d')];
  const entry = fakeDir('app', files, 2, () => {
    reads += 1;
  });
  const { read, readLimitHit } = await treeFromEntry(entry, keepAll, { maxRead: 4 });
  assert.equal(read, 4);
  assert.equal(readLimitHit, true);
  assert.equal(reads, 2);
});

test('does not open the next folder after the limit', async () => {
  const unopened = {
    name: 'later',
    isDirectory: true,
    createReader() {
      throw new Error('folder was opened after the limit');
    },
  };
  const entry = fakeDir('app', [unopened, fakeFile('a')]);
  const result = await treeFromEntry(entry, keepAll, { maxRead: 2 });
  assert.equal(result.read, 2);
  assert.equal(result.readLimitHit, true);
  assert.equal(result.unreadable, 0);
});

test('stays under the limit without reporting it', async () => {
  const entry = fakeDir('app', [fakeFile('a'), fakeFile('b'), fakeFile('c')]);
  const { read, readLimitHit } = await treeFromEntry(entry, keepAll, { maxRead: 4 });
  assert.equal(read, 3);
  assert.equal(readLimitHit, false);
});

test('keeps batches read before a folder fails', async () => {
  let reads = 0;
  const flaky = {
    name: 'app',
    isDirectory: true,
    createReader: () => ({
      readEntries(resolve, reject) {
        reads += 1;
        if (reads === 1) resolve([fakeFile('a')]);
        else reject(new Error('denied'));
      },
    }),
  };
  const { totalFiles, unreadable } = await treeFromEntry(flaky, keepAll);
  assert.equal(totalFiles, 1);
  assert.equal(unreadable, 1);
});

test('stops when cancelled', async () => {
  const entry = fakeDir('app', [fakeFile('a')]);
  assert.equal(await treeFromEntry(entry, keepAll, { isCancelled: () => true }), null);
});

test('cancelling between batches stops further reads', async () => {
  let reads = 0;
  const files = [fakeFile('a'), fakeFile('b'), fakeFile('c'), fakeFile('d')];
  const entry = fakeDir('app', files, 2, () => {
    reads += 1;
  });
  const result = await treeFromEntry(entry, keepAll, { isCancelled: () => reads >= 1 });
  assert.equal(result, null);
  assert.equal(reads, 1);
});

test('control characters cannot break a line', async () => {
  assert.equal(await render(['app/a\nb.txt']), 'app/\n└── a?b.txt');
});

test('wraps in a fence longer than any backtick run', () => {
  assert.equal(wrapInFence('app/'), '```text\napp/\n```');
  assert.equal(wrapInFence('`-- a'), '```text\n`-- a\n```');
  assert.equal(wrapInFence('```/'), '````text\n```/\n````');
});

test('en and ja share keys and placeholders', () => {
  const en = JSON.parse(readFileSync('strings/en.json', 'utf8'));
  const ja = JSON.parse(readFileSync('strings/ja.json', 'utf8'));
  assert.deepEqual(Object.keys(ja), Object.keys(en));
  assert.match(en.KOFI_URL, /^https:\/\/ko-fi\.com\/[^/\s]+$/);
  assert.equal(ja.KOFI_URL, '');

  const placeholders = (text) => (text.match(/\{\w+\}/g) ?? []).sort();
  for (const key of Object.keys(en)) {
    assert.deepEqual(placeholders(ja[key]), placeholders(en[key]), key);
  }
});

test('only finished URLs count as configured', () => {
  assert.equal(isConfiguredUrl(''), false);
  assert.equal(isConfiguredUrl(undefined), false);
  assert.equal(isConfiguredUrl('https://ko-fi.com/YOUR-KOFI-NAME'), false);
  assert.equal(isConfiguredUrl('https://ko-fi.com/richend'), true);
  assert.equal(isConfiguredUrl('https://github.com/sponsors/Richend0913'), true);
});

test('every data-i18n key in the page exists in en.json', () => {
  const en = JSON.parse(readFileSync('strings/en.json', 'utf8'));
  const html = readFileSync('index.html', 'utf8');
  const keys = [...html.matchAll(/data-(?:i18n|href)="(\w+)"/g)].map((match) => match[1]);
  assert.ok(keys.length > 10);
  for (const key of keys) assert.ok(key in en, key);
});
