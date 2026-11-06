# FolderTree

Turn a folder into a README tree.

FolderTree is a free, single-purpose web tool. Choose a local folder and it builds a tree you can paste into a GitHub README:

```text
my-project/
├── src/
│   ├── index.js
│   └── utils.js
├── LICENSE
└── README.md
```

It runs entirely in your browser, with no login and no build step.

## How to use

1. Open the page, then click **Choose folder** or drop a folder onto the page.
2. Adjust the options. The tree updates as you go.
3. Click **Copy tree** to copy it, or **Download .txt** to save it.

## Options

| Option | Default | Notes |
| --- | --- | --- |
| Exclude | All on | `node_modules`, `.git`, `dist`, `build`, `.next`, `__pycache__`, `.idea`, `.vscode`, `coverage`, `vendor` |
| Show hidden files | On | Names that start with a dot |
| Custom exclude patterns | `.DS_Store, Thumbs.db` | Comma-separated names, with `*` and `?` as wildcards |
| Depth limit | Unlimited | 1 to 10 levels |
| Tree style | Unicode | Unicode (`├──`) or ASCII (`\|--`) |
| Wrap copy in a Markdown code fence | On | Applies to Copy tree only. Downloads are always plain text |

Exclusions match names at any level, including files. The folder you pick is never excluded, even if it is named `dist`.

## Limits

- Trees are cut off at 5,000 files, and the page shows how many were found.
- Reading stops after 200,000 items.
- With **Choose folder**, excluded items still count toward the read limit because the browser lists every file up front. Drag and drop skips excluded folders without opening them.
- Empty folders may be missing with **Choose folder**, because browsers can only list the files inside a selected folder. Drag and drop keeps them.

## Privacy

Your files stay on your device. Nothing is uploaded.

FolderTree reads file and folder names and how they are nested. It never opens file contents. There is no server, tracking, cookies or ads, and the page's Content Security Policy only allows it to load its own files.

Some browsers ask you to confirm an "upload" when you choose a folder. That is the browser's standard wording for giving a page access to a folder. Nothing leaves your device.

## Replacing the Ko-fi link

The Ko-fi link is a placeholder until a Ko-fi account exists. After creating the account, change this one place:

1. Open `strings/en.json`.
2. Set `KOFI_URL` to your Ko-fi page. It starts as `https://ko-fi.com/YOUR-KOFI-NAME`.

Leave `KOFI_URL` empty in `strings/ja.json`.

## Development

No dependencies or build step. The page uses ES modules and loads its strings with `fetch`, so serve it over HTTP instead of opening `index.html` directly:

```sh
python3 -m http.server 8000
```

Then open <http://localhost:8000>. Run the tests from the repository root with Node 20 or later:

```sh
node --test
```

UI text lives in `strings/en.json`. `strings/ja.json` has the same keys, and the page currently shows English only.

## License

[MIT](LICENSE)
