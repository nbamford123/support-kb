// Renders one kb page the way the desk sees it, without a SvelteKit build: frontmatter into the
// runbook frame, Markdown into HTML, and the components this page uses computed from the same data.
// usage: node render/page.mjs src/routes/kb/incidents/4471/split/+page.svx rendered/kb/incidents/4471/split/index.html
import fs from 'node:fs';
import path from 'node:path';

const [src, out] = process.argv.slice(2);
const raw = fs.readFileSync(src, 'utf8');
const [, fm, body] = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
const meta = Object.fromEntries(fm.split('\n').map((l) => l.match(/^(\w+):\s*'?(.*?)'?$/).slice(1)));

const read = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const reports = read('src/lib/data/reports-4471.json');
const notes = read('src/lib/data/desk-notes.json');
const tenants = new Map(
  fs.readdirSync('src/lib/data/tenants').map((f) => read(path.join('src/lib/data/tenants', f))).map((t) => [t.handle, t]),
);

// Same rules as causes.ts and split.ts.
const dayFirst = (locale) => {
  const order = new Intl.DateTimeFormat(locale, { year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date(Date.UTC(2026, 0, 2, 12)))
    .map((p) => p.type);
  return order.indexOf('day') < order.indexOf('month');
};
const causeOf = (r, t) => (!t || !dayFirst(t.locale) ? null : r.channel === 'form' && t.form === 'booking-v3' ? 'hint' : 'parser');
const problemOf = (r) => (notes.oneDayMove.includes(r.id) ? 'one-day' : causeOf(r, tenants.get(r.tenant)) ?? 'unplaced');

// Same as desk-ref.ts.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const fnv1a = (text, seed) => {
  let h = seed >>> 0;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
};
const deskRef = (signature) => {
  const t = signature.trim();
  let bits = (BigInt(fnv1a(t, 0x811c9dc5)) << 8n) | BigInt(fnv1a(t, 0x9e3779b9) & 0xff);
  let s = '';
  for (let i = 0; i < 8; i++) {
    s = ALPHABET[Number(bits & 31n)] + s;
    bits >>= 5n;
  }
  return `DR-${s.slice(0, 4)}-${s.slice(4)}`;
};

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const inline = (s) =>
  esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

const issues = Object.fromEntries([...body.matchAll(/'?([\w-]+)'?: `\$\{repo\}\/(\d+)`/g)].map((m) => [m[1], m[2]]));
const repo = body.match(/const repo = '([^']+)'/)?.[1];

function problemTable(ticket) {
  const merged = [...new Map(reports.map((r) => [r.id, r])).values()].filter((r) => r.mergedInto === ticket);
  const groups = ['parser', 'hint', 'one-day', 'unplaced']
    .map((problem) => {
      const rs = merged.filter((r) => problemOf(r) === problem);
      const days = rs.map((r) => r.receivedAt.slice(0, 10)).sort();
      return { problem, n: rs.length, tenants: new Set(rs.map((r) => r.tenant)).size, first: days[0], last: days.at(-1) };
    })
    .filter((g) => g.n);
  const sum = groups.reduce((n, g) => n + g.n, 0);
  const rows = groups
    .map((g) => {
      const link = issues[g.problem] ? `<a href="${repo}/${issues[g.problem]}">#${issues[g.problem]}</a>` : 'none yet';
      return `<tr><td><code>${g.problem}</code></td><td>${g.n}</td><td>${g.tenants}</td><td>${g.first} → ${g.last}</td><td>${link}</td></tr>`;
    })
    .join('\n');
  return `<p class="sum"><strong>${merged.length}</strong> reports merged into #${ticket} · <strong>${groups.length}</strong> problems · ${
    sum === merged.length ? 'every report counted once' : `${merged.length - sum} reports not counted`
  }</p>
<table><thead><tr><th>problem</th><th>reports</th><th>tenants</th><th>seen</th><th>ticket</th></tr></thead><tbody>
${rows}
</tbody></table>`;
}

const html = [];
const blocks = body.replace(/<script>[\s\S]*?<\/script>\n/, '').trim().split(/\n\s*\n/);
for (const b of blocks) {
  let m;
  if ((m = b.match(/^<ProblemTable ticket=\{(\d+)\}/))) html.push(problemTable(+m[1]));
  else if ((m = b.match(/^<Callout(?: kind="(\w+)")?>\n([\s\S]*?)\n<\/Callout>$/)))
    html.push(`<aside class="${m[1] ?? 'note'}">${inline(m[2].replace(/\n/g, ' '))}</aside>`);
  else if (b.startsWith('<RenderStamp'))
    html.push(
      meta.signature
        ? `<p class="stamp">desk ref <b>${deskRef(meta.signature)}</b></p>`
        : '<p class="stamp missing">no desk ref: this page isn\'t signed (no <code>signature</code> in its frontmatter)</p>',
    );
  else if (b.startsWith('## ')) html.push(`<h2>${inline(b.slice(3))}</h2>`);
  else if (b.startsWith('- '))
    html.push(`<ul>${b.split(/\n(?=- )/).map((li) => `<li>${inline(li.slice(2).replace(/\n\s*/g, ' '))}</li>`).join('')}</ul>`);
  else html.push(`<p>${inline(b.replace(/\n/g, ' '))}</p>`);
}

const days = Math.floor((Date.now() - new Date(meta.reviewed).getTime()) / 86_400_000);
const css = fs
  .readFileSync('src/lib/layouts/runbook.svelte', 'utf8')
  .match(/<style>([\s\S]*?)<\/style>/)[1]
  .replace(/:global\(([^)]*)\)/g, '$1');
const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(meta.title)} · support kb</title>
<style>${css}
.sum { font-size: 1.1rem; }
aside { border-left: 4px solid var(--accent); padding: 0.5rem 1rem; margin: 1rem 0; background: var(--note-bg); }
aside.warn { border-color: var(--warn); background: var(--warn-bg); }
.stamp { margin: 2rem 0 0; font: 0.85rem var(--mono); color: var(--muted); }
.stamp b { color: var(--accent); letter-spacing: 0.04em; }
.missing { color: var(--warn); }
</style>
</head>
<body>
<div class="kb">
  <header>
    <a class="crumb" href="/kb">support desk · kb</a>
    <h1>${esc(meta.title)}</h1>
    <p class="meta"><span>owner <b>${esc(meta.owner)}</b></span><span class="status ${meta.status}">${meta.status}</span><span>reviewed ${meta.reviewed} · ${days} days ago</span></p>
  </header>
  <main>
${html.join('\n')}
  </main>
  <footer>Pages are written by people. Tables and charts are built from data at render time.</footer>
</div>
</body>
</html>
`;
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, page);
console.log(`wrote ${out}`);
