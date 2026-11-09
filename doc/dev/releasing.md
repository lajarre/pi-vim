# releasing

How a pi-vim version goes from a green branch to npm, GitHub and the
issue tracker. Publishing itself is automated; everything around it is
manual and ordered.

## preconditions

- The dev host is the latest Pi (`npm install` after bumping the
  `@earendil-works/*` dev dependencies) and every gate is green on it:
  `npm run check`, `npm run test:nvim`, `npm run test:smoke`,
  `npm run pack:check`; `doc/dev/scoreboard.md` regenerated.
- TTY-only behavior (cursor shapes, labels, selection paint, real paste,
  clipboard) was checked by hand on the official standalone Pi binary
  and on a Node install, per the maintainer QA runbook.
- README tables and the divergence table describe the release; the
  package budget comment in `script/pack-check.ts` is dated.
- Replies for every issue and PR the release touches are drafted:
  facts only, what landed, what was verified, known limits, the commit
  ids on `main`. No thanks boilerplate; the maintainer adds the personal
  note by hand.

## version numbers

Until 1.0: a patch release carries regression fixes only; a minor release
carries features or any behavior change, including breaking ones (a raised
Pi floor, a changed default). From 1.0 on, semantic versioning applies as
written. 0.15.1 shipped features under a patch number before this rule
was set; it is recorded, not rewritten.

## steps

1. Bump on the release branch: `npm version <x.y.z> --no-git-tag-version`,
   commit `package.json` and `package-lock.json` as
   `chore(release): bump version to <x.y.z>`.
2. Fast-forward `main` to the branch (`git merge --ff-only`); never a
   merge commit.
3. Tag and push together: `git tag -a v<x.y.z> -m "pi-vim <x.y.z>" main`
   then `git push origin main v<x.y.z>`.
4. The push runs `.github/workflows/publish.yml`, which publishes the
   `package.json` version when it is not on npm yet. Wait for it:
   `gh run watch`; confirm with `npm view pi-vim version`.
5. GitHub release `pi-vim <x.y.z>` from the prepared note: the Pi
   requirement line, then Added / Fixed / Changed / Not included.
6. Post the replies, close the issues as completed and the landed or
   declined PRs; reviews that request changes stay open.
7. Record what the release did not cover (platforms not verified, known
   limits) where the next release planning lives.

Patch releases that only fix a regression follow the same steps; the
note lists the fix and the hosts it was verified on.

## what the workflow does not do yet

`publish.yml` runs lint, typecheck, unit tests and the package check, not
the nvim parity or consumer smoke suites, and it creates neither the git
tag nor the GitHub release. Until that changes, steps 3 and 5 are manual
and the branch gates in the preconditions are the real release gate.
