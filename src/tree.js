// Pure tree logic with no DOM access, so it can be tested under Node.
// Only names and hierarchy are ever read. File contents are never opened.

export const DEFAULT_EXCLUDES = [
  'node_modules', '.git', 'dist', 'build', '.next',
  '__pycache__', '.idea', '.vscode', 'coverage', 'vendor',
];
export const DEFAULT_PATTERNS = '.DS_Store, Thumbs.db';
export const MAX_FILES = 5000;
export const MAX_READ = 200000;

const YIELD_EVERY = 5000;

const GLYPHS = {
  unicode: { branch: '├── ', last: '└── ', pipe: '│   ', gap: '    ' },
  ascii: { branch: '|-- ', last: '`-- ', pipe: '|   ', gap: '    ' },
};

// Fixed locale, so the same folder gives the same tree on every machine.
const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

export function parsePatterns(input) {
  return input
    .split(',')
    .map((pattern) => pattern.trim().replace(/\/+$/, ''))
    .filter(Boolean);
}

function globToRegExp(glob) {
  const source = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*+/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${source}$`, 's');
}

// Returns (name) => boolean. Matching is by name at any level, so excluding a
// folder also drops everything inside it.
export function createFilter({ excludes = [], patterns = [], showHidden = true } = {}) {
  const exact = new Set(excludes);
  const globs = [];
  for (const pattern of patterns) {
    if (/[*?]/.test(pattern)) globs.push(globToRegExp(pattern));
    else exact.add(pattern);
  }
  return (name) =>
    (!showHidden && name.startsWith('.')) ||
    exact.has(name) ||
    globs.some((glob) => glob.test(name));
}

function makeNode(name, isDir) {
  return { name, isDir, children: isDir ? new Map() : null };
}

function compareNodes(a, b) {
  if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
  return collator.compare(a.name, b.name) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}

// Turns child Maps into sorted arrays and counts what the scan kept.
function finalize(root) {
  let totalFiles = 0;
  let totalFolders = 0;
  const visit = (node) => {
    node.children = [...node.children.values()].sort(compareNodes);
    for (const child of node.children) {
      if (child.isDir) {
        totalFolders += 1;
        visit(child);
      } else {
        totalFiles += 1;
      }
    }
  };
  visit(root);
  return { totalFiles, totalFolders };
}

const pause = () => new Promise((resolve) => setTimeout(resolve));

// `paths` are webkitRelativePath values: "root/dir/file.txt". The first segment
// is the folder the user picked, so it is never filtered, even if it is named
// "dist" or ".config".
export async function treeFromPaths(paths, isExcluded, options = {}) {
  const { maxRead = MAX_READ, isCancelled = () => false, onProgress = () => {} } = options;
  const root = makeNode(paths[0].split('/')[0], true);
  let read = 0;
  let readLimitHit = false;

  for (const path of paths) {
    if (read >= maxRead) {
      readLimitHit = true;
      break;
    }
    read += 1;
    if (read % YIELD_EVERY === 0) {
      onProgress(read);
      await pause();
      if (isCancelled()) return null;
    }

    const segments = path.split('/').slice(1);
    if (segments.some(isExcluded)) continue;

    let node = root;
    segments.forEach((name, index) => {
      const isLast = index === segments.length - 1;
      let child = node.children.get(name);
      if (!child) {
        child = makeNode(name, !isLast);
        node.children.set(name, child);
      }
      node = child;
    });
  }

  return { root, read, readLimitHit, unreadable: 0, ...finalize(root) };
}

// Directory readers return batches, so keep reading until one comes back empty.
async function readAllEntries(directory) {
  const reader = directory.createReader();
  const entries = [];
  for (;;) {
    const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
    if (batch.length === 0) return entries;
    entries.push(...batch);
  }
}

// Walks a FileSystemDirectoryEntry from a drop. Excluded folders are pruned
// without being opened, so a huge node_modules does not use up the read limit.
export async function treeFromEntry(rootEntry, isExcluded, options = {}) {
  const { maxRead = MAX_READ, isCancelled = () => false, onProgress = () => {} } = options;
  const root = makeNode(rootEntry.name, true);
  const stack = [{ entry: rootEntry, node: root }];
  let read = 0;
  let readLimitHit = false;
  let unreadable = 0;

  while (stack.length > 0 && !readLimitHit) {
    const { entry, node } = stack.pop();
    let entries;
    try {
      entries = await readAllEntries(entry);
    } catch {
      unreadable += 1;
      continue;
    }
    if (isCancelled()) return null;

    for (const child of entries) {
      if (read >= maxRead) {
        readLimitHit = true;
        break;
      }
      read += 1;
      if (read % YIELD_EVERY === 0) onProgress(read);
      if (isExcluded(child.name)) continue;

      const childNode = makeNode(child.name, child.isDirectory);
      node.children.set(child.name, childNode);
      if (child.isDirectory) stack.push({ entry: child, node: childNode });
    }
  }

  return { root, read, readLimitHit, unreadable, ...finalize(root) };
}

// File names may legally contain newlines and other control characters.
const cleanName = (name) => name.replace(/[\u0000-\u001f\u007f]/g, '?');

export function renderTree(root, { style = 'unicode', maxDepth = Infinity, maxFiles = MAX_FILES } = {}) {
  const glyphs = GLYPHS[style];
  const lines = [`${cleanName(root.name)}/`];
  let shownFiles = 0;
  let shownFolders = 0;
  let truncated = false;

  const walk = (node, prefix, depth) => {
    if (depth > maxDepth) return;
    node.children.forEach((child, index) => {
      if (truncated) return;
      if (!child.isDir && shownFiles >= maxFiles) {
        truncated = true;
        return;
      }
      const isLast = index === node.children.length - 1;
      const suffix = child.isDir ? '/' : '';
      lines.push(`${prefix}${isLast ? glyphs.last : glyphs.branch}${cleanName(child.name)}${suffix}`);
      if (child.isDir) {
        shownFolders += 1;
        walk(child, prefix + (isLast ? glyphs.gap : glyphs.pipe), depth + 1);
      } else {
        shownFiles += 1;
      }
    });
  };
  walk(root, '', 1);

  return { text: lines.join('\n'), shownFiles, shownFolders, truncated };
}

// The fence must be longer than any backtick run in the tree, or a folder
// named with backticks would close it early.
export function wrapInFence(text) {
  const runs = text.match(/`+/g) ?? [];
  const longestRun = runs.reduce((longest, run) => Math.max(longest, run.length), 0);
  const fence = '`'.repeat(Math.max(3, longestRun + 1));
  return `${fence}text\n${text}\n${fence}`;
}
