# Security and licensing audit

Reviewed 17 November 2026 against commit `2905375` and the current working tree. Existing Composer, stylesheet and preview edits were included in inspection and left unchanged. This audit changes documentation only.

The main release risks are incomplete third-party licensing materials and unbounded work in authenticated server endpoints. No cross-channel authorization bypass or confirmed script execution was established. The findings below distinguish demonstrable behavior from deployment-dependent impact.

## Security remediation on 18 November 2026

The security findings below describe the audited behavior before remediation. Search now
returns at most 50 inspected posts per request, limits encoded matching posts to 1 MiB,
validates channel-bound continuation cursors and stops between RPCs on cancellation.
The client follows pages progressively and aborts on search changes. Search, view and
forward bodies are limited to 16 KiB and must contain exactly one JSON value. Four
simultaneous search/schedule operations are admitted per plugin instance.

Queue additions and removals share a cluster mutex; creation enforces 100 records per user, 500 total and
16 MiB of stored schedule data. Failed records count until removed. Global KV scans are
bounded to fewer than 1000 keys and 32 MiB; list callers share a three-second cache rather
than each forcing an independent scan. Existing queues beyond those scan budgets fail
closed and require excess records to be removed; the change does not silently delete
pending messages. The existing queue/list format and cancellation/delivery claims remain
compatible. The storage scan remains global, but its size and repetition are bounded.
Delivery reconciliation also stops after ten 100-post pages and honors cancellation.
Exhausting that budget returns an error rather than treating incomplete history as proof
of non-delivery; ambiguous records can require manual review.

External attachment images require explicit loading, and these image loads omit
the referrer. Same-origin image URLs continue to render automatically. Fallback Markdown
and attachment links validate URL schemes independently of React. The lockfile now uses
`fast-uri@3.1.9`, and installation/audit reported zero npm advisories. Licensing findings
remain open. Go HTTP/2 scanner triage below is unchanged.

Validation: `make test` passed all type, smoke, production bundle and asset stages; its Go
stage encountered a read-only sandbox cache. `make test-server test-package` then passed
outside the sandbox, including vet, server build and all six platform packaging checks.
`go test -race ./...` passed with the new cluster quota, mutation-lock and cancellation
regressions. UI previews were regenerated, and the new client tests cover continuation
pages, aborts, rate-limit handling, URL filtering and image consent.

## Licensing findings

### ELK redistribution needs its own license and source information

**Priority: high before the next release.** Importing the full Mermaid package includes its ELK layout loader. The installed Mermaid distribution embeds `elkjs@0.12.0` in `dist/chunks/mermaid.esm/elk-JD43GPKC.mjs`; this is separate from the `elkjs@0.12.1` entry in the npm dependency tree. Inspecting only package metadata misses this embedded copy.

ELK is available under EPL-2.0 or GPL-3.0-or-later. Choosing EPL avoids choosing the GPL alternative, but still requires the EPL text and a statement explaining where recipients can obtain the covered source. The packaging script supplies neither an ELK license nor an ELK source statement. The generated JavaScript license sidecars contain only a handful of other notices.

Include the appropriate ELK license, notices and a source location matching the embedded version, or exclude ELK from the shipped build. Confirm the licensing of its embedded components as part of that inventory. This does not by itself require relicensing independently written plugin code. See [EPL section 3](https://www.eclipse.org/org/documents/epl-2.0/EPL-2.0.html).

Evidence: `webapp/src/ui/MermaidDiagram.tsx:9`, the installed Mermaid layout loader and ELK chunk, `webapp/node_modules/elkjs/LICENSE.md`, and `scripts/package.js:35`.

### Release archives omit the project license and dependency notices

**Priority: medium.** `scripts/package.js:35` copies only `assets`, `public`, the startup bundle and the executable. Inspection of the existing linux-amd64 archive confirmed that it lacks the root MIT `LICENSE`, the standalone Vazirmatn `OFL.txt`, and a comprehensive set of notices for bundled JavaScript and linked Go dependencies. For example, Mermaid's full MIT notice is absent from the generated license sidecars. A package's own MIT declaration does not replace its dependencies' licenses.

Ship the root license and a generated third-party notice directory covering the actual webpack module graph, prebundled upstream code, Go executable dependencies and fonts. Include Vazirmatn's original OFL and copyright text explicitly; whether its font metadata independently satisfies the OFL was not established. MIT requires preservation of its copyright and permission notice; font redistribution also has attribution requirements. See the [MIT text](https://opensource.org/license/mit) and [OFL redistribution guidance](https://openfontlicense.org/how-to-use-ofl-fonts/).

The Twemoji artwork license, attribution and modification description are already copied through `assets/emoji/`. PDF.js copies its main Apache license and the licenses inside the CMap, standard font and WASM directories. Those are useful existing safeguards.

### PDF standard fonts have obligations beyond Apache

**Priority: medium compliance review.** `scripts/prepare-pdfjs.js:17` copies Liberation TTF files. In the pinned `pdfjs-dist@6.5.438`, `standard_fonts/LICENSE_LIBERATION` explicitly identifies GPLv2 with the Liberation font exception. The exception concerns documents using the font; it should not be read as removing the redistribution obligations for the font files themselves.

The font license is preserved, so this is not a missing-license finding. However, the generated top-level PDF notice describes only Apache-2.0, and the release has no explicit corresponding-source provision for these font binaries. Establish and document a compliant source distribution route for the exact font version, or replace/remove these assets with an appropriately licensed alternative and verify PDF fallback rendering. This finding concerns the font assets; it does not establish that the plugin as a whole must become GPL. Review the exact shipped license rather than assuming current upstream Liberation licensing applies to these older assets.

## Security findings

### Channel search permits expensive scans without a work budget

**Priority: medium.** `server/plugin.go:219` pages through all channel history, retaining every encountered post ID and all matching posts until the complete response can be returned. Any authenticated member of a large channel can repeat this request. There is no page/result budget, concurrency limit or cancellation check in the loop. Even an unsuccessful search performs the complete scan. The request body decoder also lacks the size limit used by the newer endpoints.

This creates database, RPC and memory amplification for an ordinary member. Host request rate limits can reduce request frequency but do not bound the work of one accepted request. Impact depends on channel size and host protections; no production load attack was performed.

A temporary Go overlay test canceled the request before dispatch and supplied 500 synthetic pages of 100 posts. The handler still made 501 history calls and produced a 20,150,022-byte response. A second test sent a 2 MiB views JSON body with an empty ID list; the endpoint accepted it despite its 100-ID processing limit. The overlay files stayed outside the repository and are not regression tests that endorse these behaviors.

Return bounded pages with a continuation token, stop on cancellation, enforce a server work/time budget, and bound the JSON body. Preserve exhaustive search by continuing across requests instead of accumulating an entire channel in one request.

### Scheduled messages have no queue quota and listing reads the global queue

**Priority: medium.** Schedule creation limits each record to roughly 60 KB but does not limit the number of records per user or total pending bytes. `server/scheduled_posts.go:50` enumerates and decodes every schedule; a user's GET calls this before filtering to that user's records at line 95. The worker repeats this traversal every 30 seconds, including records whose delivery has failed permanently.

A member with posting permission can grow persistent storage and increase work for other users and the worker. Repeated list requests also amplify reads of everybody's queue. User ownership checks prevent those other records from being returned; this is a resource exhaustion concern, not a demonstrated privacy leak.

Enforce per-user and global queue quotas atomically, index schedules by owner and due time, paginate lists, and define expiration/cleanup for failed records. A simple read-count-then-write quota would race across requests and cluster nodes.

### Attachment images bypass the host image proxy path

**Priority: medium where image privacy controls are expected.** `webapp/src/ui/MessageList.tsx:698` sets `<img src>` directly from `post.props.attachments[].image_url`. A post attachment can therefore make viewers' browsers contact an external image origin as it becomes visible. The component does not use Mattermost's proxied image metadata or apply its own referrer restriction.

An attachment controlled by a sender or integration can disclose viewer IP addresses and viewing times. Referrer disclosure depends on the host/browser policy; CSP may block the request. This is a browser request, not demonstrated server-side SSRF. A deployment that intentionally permits direct remote image requests may accept this behavior, but deployments relying on the native image proxy should not silently lose that protection in the overlay.

Resolve images through the host's trusted proxy/image metadata and honor its display settings. Add an explicit referrer policy as a supplementary measure; it does not hide the viewer's IP from a directly contacted server.

### The npm build toolchain contains an affected fast URI version

**Priority: low for this plugin.** `webapp/package-lock.json:4142` pins `fast-uri@3.1.8` through `babel-loader → schema-utils → ajv`. `npm audit --json` reported one affected package with four advisories, aggregate severity moderate. The patched version is 3.1.9 or later. This is a development dependency; no plugin runtime attack path was established. `npm audit --omit=dev --json` reported zero advisories.

Refresh the lockfile within the existing compatible dependency constraints and rerun the build. See the maintainer's [scheme spoofing advisory](https://github.com/fastify/fast-uri/security/advisories/GHSA-w74x-v6f9-j3xg), [path equivalence advisory](https://github.com/fastify/fast-uri/security/advisories/GHSA-xhq7-xmqj-769h), [host confusion advisory](https://github.com/fastify/fast-uri/security/advisories/GHSA-wjr9-j795-jxcr), and [suffix scheme injection advisory](https://github.com/fastify/fast-uri/security/advisories/GHSA-333x-w4r6-6crp).

## Scanner triage and hardening notes

- `govulncheck` v1.9.0, using Go 1.27.4, reported four non-withdrawn advisories with symbol traces through `golang.org/x/net@v0.58.0` and the go-plugin gRPC server branch: GO-2026-6603, GO-2026-6611, GO-2026-6612 and GO-2026-6617. Their x/net fix is v0.60.0. Inspection of Mattermost's `plugin.ClientMain` shows that gRPC is not configured: it explicitly serves net/rpc, and go-plugin selects gRPC only when `ServeConfig.GRPCServer` is non-nil. These static traces therefore do not establish HTTP/2 exposure in this plugin. Keep the dependency current, but do not report these as confirmed remote plugin vulnerabilities. Other module/package findings lacked called-symbol traces; withdrawn advisories were excluded.
- Fallback Markdown links (`webapp/src/ui/render.tsx:341`) and attachment title/author links (`MessageList.tsx:694`) accept arbitrary URL schemes. The installed React 19 blocked a `javascript:` URL in a local render reproduction. The manifest requires Mattermost 12; an exploit on a supported host was not established. Explicit scheme validation would make the code less dependent on host behavior. React's [older behavior only warned](https://legacy.reactjs.org/blog/2019/08/08/react-v16.9.0.html), which matters if older-host compatibility is reintroduced.
- Mermaid uses strict mode and protects security-related configuration against message directives. PDF previews render to a bounded canvas, fetch attachment bytes with a streaming limit, and do not instantiate PDF scripting. These controls were present; the audit does not treat an HTML insertion sink alone as proof of XSS.
- Server SQL values use placeholders. Todo access, forwarding and view statistics check channel membership. Schedules check sender ownership, file ownership and posting permission, and revalidate before delivery. Bulk notification changes require a system administrator. No authorization bypass was demonstrated in these paths.

## Validation and scope

Dependency scans queried the npm and official Go vulnerability databases. Source inspection covered server routes, permissions, SQL, scheduler persistence, Markdown/SVG/PDF rendering, attachments, API requests, packaging and release workflows. The existing linux-amd64 archive was inspected for license contents. A local jsdom reproduction confirmed React 19's JavaScript-URL block, and temporary Go overlay tests reproduced unbounded canceled-search work and oversized JSON acceptance. No live Mattermost instance, older host, production load attack or successful XSS exploit was used.

`make test` passed type checks, all smoke suites, the production build, PDF/lazy/bundle checks, Go tests, vet and the server build. Its final package test encountered a sandbox `spawnSync ... EPERM`; rerunning `make test-package` outside that sandbox passed all six platform checks. The fresh lazy output also contains ELK (`public/webapp/1195.ecd2485737e2.js`), confirming the embedded component ships. Passing functional tests does not establish the absence of security or licensing defects. No implementation fixes are included in this audit commit.
