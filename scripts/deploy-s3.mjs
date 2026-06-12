// Deploy the static site to S3, optionally under an S3 key prefix so the
// site can be mounted under a sub-path of an existing CloudFront distribution
// (e.g. /solutions-hub/* on E39WJRUVOH25A4). When a prefix is set, HTML files
// are rewritten on the way out so root-absolute links resolve under the prefix.
//
// Required env vars:
//   S3_BUCKET                   e.g. leadsplease-test-solutions-microsite
//   CLOUDFRONT_DISTRIBUTION_ID  e.g. E39WJRUVOH25A4
// Optional:
//   S3_KEY_PREFIX               e.g. solutions-hub (no leading/trailing slash)
//   AWS_REGION                  defaults to us-east-1
//   DRY_RUN=1                   pass --dryrun to all sync calls

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');

const bucket = process.env.S3_BUCKET;
const distId = process.env.CLOUDFRONT_DISTRIBUTION_ID;
const region = process.env.AWS_REGION || 'us-east-1';
const prefix = (process.env.S3_KEY_PREFIX || '').replace(/^\/+|\/+$/g, '');
const dry = process.env.DRY_RUN === '1' ? ['--dryrun'] : [];

if (!bucket) { console.error('S3_BUCKET is required'); process.exit(1); }
if (!distId) { console.error('CLOUDFRONT_DISTRIBUTION_ID is required'); process.exit(1); }

const dest = `s3://${bucket}/${prefix ? prefix + '/' : ''}`;
console.log(`Bucket:       ${bucket}`);
console.log(`Key prefix:   ${prefix || '(root)'}`);
console.log(`Distribution: ${distId}`);
console.log(`Region:       ${region}`);
console.log(`Destination:  ${dest}`);
console.log('');

// Files that exist only to run the site on Node, configure tooling, or hold
// infra-as-code — never upload these. Matched by top-level name only; if you
// add a dir here, its entire subtree is excluded.
const excludeNames = new Set([
  '.git', 'node_modules', 'scripts', 'cloudfront',
  '.idea', '.vscode',
  'server.js', 'Dockerfile', 'railway.toml',
  'package.json', 'package-lock.json',
  '.gitignore', '.dockerignore',
  '.env', '.env.local', '.env.production',
]);

// Build a staging directory containing only the files that should go to S3,
// with HTML rewritten if a prefix is set. This keeps the source tree clean
// (Railway / local-dev still serve from / unchanged).
const staging = mkdtempSync(join(tmpdir(), 'lp-deploy-'));
console.log(`Staging:      ${staging}`);

function copyTree(src, dst) {
  for (const name of readdirSync(src)) {
    if (excludeNames.has(name)) continue;
    const s = join(src, name);
    const d = join(dst, name);
    const st = statSync(s);
    if (st.isDirectory()) {
      cpSync(s, d, { recursive: true });
    } else {
      cpSync(s, d);
    }
  }
}
copyTree(repoRoot, staging);

// Rewrite root-absolute href/src/content attributes in HTML so they resolve
// under the S3 key prefix. We use a positive allowlist of path heads we know
// about to avoid touching protocol-relative URLs, fragments, or stray slashes
// in inline scripts/JSON-LD.
function rewriteHtml(html, p) {
  // Matches:  href="/..."  href='/...'  (same for src and content)
  // The leading slash is followed by either end-of-attr (home link),
  // a "#" (anchor on home), or one of our known top-level paths.
  const re = /(\s(?:href|src|content)\s*=\s*["'])\/(?=$|["']|#|_astro\/|industries\/|applied\/|manifest\.json|sitemap\.xml|robots\.txt|llms\.txt)/g;
  return html.replace(re, `$1/${p}/`).replace(`/${p}//`, `/${p}/`);
}

function walkAndRewrite(dir, p) {
  let count = 0;
  for (const name of readdirSync(dir)) {
    const f = join(dir, name);
    const st = statSync(f);
    if (st.isDirectory()) {
      count += walkAndRewrite(f, p);
    } else if (name.endsWith('.html')) {
      const before = readFileSync(f, 'utf8');
      const after = rewriteHtml(before, p);
      if (after !== before) {
        writeFileSync(f, after);
        count++;
      }
    }
  }
  return count;
}

if (prefix) {
  const n = walkAndRewrite(staging, prefix);
  console.log(`Rewrote root-absolute links in ${n} HTML files → /${prefix}/...`);
}

// Spawn aws directly (no shell) so args like 'public, max-age=..., immutable'
// pass through verbatim. shell:true on Windows splits them on whitespace.
function run(args) {
  console.log('> aws', args.map(a => a.includes(' ') ? `"${a}"` : a).join(' '));
  const r = spawnSync('aws', args, { stdio: 'inherit' });
  if (r.status !== 0) { console.error(`aws exited with ${r.status}`); cleanup(); process.exit(r.status || 1); }
}

function cleanup() {
  try { rmSync(staging, { recursive: true, force: true }); } catch {}
}

try {
  // Pass 1 — hashed Astro assets: long-lived immutable cache.
  run([
    's3', 'sync', staging, dest,
    '--region', region,
    '--exclude', '*',
    '--include', '_astro/*',
    '--cache-control', 'public, max-age=31536000, immutable',
    ...dry,
  ]);

  // Pass 2 — everything except HTML and _astro: medium cache.
  run([
    's3', 'sync', staging, dest,
    '--region', region,
    '--exclude', '_astro/*',
    '--exclude', '*.html',
    '--cache-control', 'public, max-age=3600',
    ...dry,
  ]);

  // Pass 3 — HTML: never cache at the edge or browser.
  // --delete only on this pass so removed routes are pruned from S3 (scoped
  // to the prefix, so it can't touch anything outside our subtree).
  run([
    's3', 'sync', staging, dest,
    '--region', region,
    '--exclude', '*',
    '--include', '*.html',
    '--cache-control', 'no-store, no-cache, must-revalidate, max-age=0',
    '--delete',
    ...dry,
  ]);

  if (process.env.DRY_RUN === '1') {
    console.log('DRY_RUN set — skipping CloudFront invalidation');
  } else {
    const invPaths = prefix
      ? [`/${prefix}`, `/${prefix}/*`]
      : ['/', '/*.html', '/industries/*', '/applied/*', '/sitemap.xml', '/robots.txt', '/llms.txt'];
    run([
      'cloudfront', 'create-invalidation',
      '--distribution-id', distId,
      '--paths', ...invPaths,
    ]);
  }

  console.log('Deploy complete.');
} finally {
  cleanup();
}
