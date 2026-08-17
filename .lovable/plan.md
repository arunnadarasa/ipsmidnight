# Update README on GitHub

Push the latest local `README.md` (which now includes the GitHub source links, real `git clone` URL, "This project" reference entry, and footer note) to the GitHub repository `arunnadarasa/ipsmidnight` so the repo's README matches the Lovable project.

There is currently no GitHub connection linked to this project, so the first step links one.

## 1. Link a GitHub connection

Call `standard_connectors--connect` with `connector_id: "github"`. This opens an in-chat approval card letting you authorize a GitHub connection (OAuth one-click is preferred; a personal access token also works). On completion, `GITHUB_API_KEY` becomes available to server code and the connection is linked to this project.

The connection needs scopes that allow reading and writing repository contents — `repo` (full) for a PAT, or the equivalent OAuth scope (`repo`/`Contents: read+write`). The Contents API write endpoint requires write access.

## 2. Server function to push the README

Add a server function `pushReadmeToGithub` in `src/lib/github-readme.functions.ts` (client-safe path, per server-function authoring rules). It is a thin wrapper that:

- Reads `process.env.LOVABLE_API_KEY` and `process.env.GITHUB_API_KEY` inside the handler; throws a clear error if either is missing.
- Calls the connector gateway:
  - `GET https://connector-gateway.lovable.dev/github/repos/arunnadarasa/ipsmidnight/contents/README.md` with headers `Authorization: Bearer ${LOVABLE_API_KEY}`, `X-Connection-Api-Key: ${GITHUB_API_KEY}`, `Accept: application/vnd.github+json` — to obtain the current file **SHA** (the Contents API requires it to update an existing file).
- Reads the local `README.md` content. Since this runs on the edge worker (no real FS for the repo checkout), the README content must be available at build time: import it as a raw string via Vite's `?raw` query (`import readmeContent from "../../README.md?raw"`) so it is inlined into the bundle. This avoids any filesystem access at runtime.
- Base64-encodes the content (`btoa` on the UTF-8 string; handle multi-byte via `TextEncoder` + a base64 helper, or `Buffer.from(content, "utf8").toString("base64")` since `Buffer` is available on the worker).
- `PUT https://connector-gateway.lovable.dev/github/repos/arunnadarasa/ipsmidnight/contents/README.md` with body `{ message: "docs: sync README with GitHub source links", content: <base64>, sha: <currentSha> }` and the same headers.
- Surfaces gateway/HTTP errors: on non-OK, read `response.text()` and throw with status + body so the cause is visible.
- Returns the commit SHA and HTML URL from the GitHub response.

All HTTP errors are logged and returned to the caller (status + body), never a bare 500.

## 3. Wire a "Push README" action into the Deploy console

In `src/routes/app.deploy.tsx` (the unified deployment console), add a small **"Update README on GitHub"** button card (or a row in an existing "Repository" / metadata section). Clicking it calls the server function via `useServerFn` inside a mutation, shows a toast on success with the commit URL, and shows the error message on failure. This keeps it within the existing console UX rather than a new route.

If `app.deploy.tsx` already has a metadata/repo section, place the button there; otherwise add a compact card at the bottom of the deploy page.

## 4. Verify

- Trigger the button from the preview.
- Confirm the GitHub response returns a commit SHA and `content.html_url`.
- Re-GET the README via the gateway and confirm the `Source:` line is present.
- Alternatively open the repo URL to confirm the rendered README shows the new lines.

## Notes

- The README is a public repo file — no secrets are involved in its content.
- The bidirectional Lovable↔GitHub Git sync would also propagate this eventually, but the connector push gives an explicit, verifiable commit immediately and works even if sync is delayed.
- No new dependencies; `fetch`, `Buffer`, and Vite `?raw` import are all available.
