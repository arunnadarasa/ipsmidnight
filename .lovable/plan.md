# Add GitHub repo link

Add the public repository link (`https://github.com/arunnadarasa/ipsmidnight`) so it is reachable from both the live app and the README.

## 1. In-app: source link in the console shell

`src/components/AppShell.tsx`

- Import `Github` from `lucide-react`.
- Add a small GitHub icon link in the **desktop sidebar footer** (the block under `<NavLinks />` that holds the email + Sign out button), above the email line. It opens `https://github.com/arunnadarasa/ipsmidnight` in a new tab (`target="_blank" rel="noopener noreferrer"`), styled as a ghost/outline affordance consistent with the existing Sign out button.
- Add the same link in the **mobile Sheet** (the left drawer), below the Sign out button, so mobile users can also reach the repo.

No business-logic changes; presentation only.

## 2. Landing page: GitHub link in the footer line

`src/routes/index.tsx`

- In the existing footer paragraph (`mt-14 text-xs` disclaimer line), append a link: `View source on GitHub` → `https://github.com/arunnadarasa/ipsmidnight`, opening in a new tab. Keeps the disclaimer text intact.

## 3. README: real repo URL in place of placeholders

`README.md`

- Top section (after the `**Live app**:` line): add a `**Source**:` line pointing to `https://github.com/arunnadarasa/ipsmidnight`.
- **Local development and setup** (`git clone <this-repository-url>` / `cd <repository-name>`): replace the placeholders with the real URL and `ipsmidnight`.
- Footer (the "Built with Lovable" line): add a short note that the source is on GitHub with the link, so the repo is discoverable from the bottom of the README.
- Add the repo URL to the **Reference links** section under a short "This project" sub-bullet so it is listed alongside the other links.

## Notes

- The link is a public repo URL, not a secret, so it can live in client-rendered code.
- No new dependencies needed; `lucide-react` already exports `Github`.
