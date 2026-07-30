# nsite-pr-preview

Publish a pull request's build as an [nsite](https://github.com/nostr-protocol/nips/pull/1538) and post the link on the PR, for nostr git repos using [ngit](https://gitworkshop.dev/ngit). Powered by [nsyte](https://github.com/sandwichfarm/nsyte).

One file, no dependencies. Clone it once, then run it from inside any repo:

```bash
node path/to/nsite-pr-preview/scripts/preview.mjs          # build and report what would be published
node path/to/nsite-pr-preview/scripts/preview.mjs --live   # publish it and comment the link on the PR
```

Or without cloning, no GitHub account needed:

```bash
npx github:ashen0x/nsite-pr-preview --live
```

Run it on any branch you have already pushed as a `pr/` branch. It installs dependencies, runs your build and stamps the output as a preview. Nothing is committed.

This repo is also the demo: its own pull requests carry links published by this tool.

## Setup

Once per machine, get a revocable signing credential from your signer:

```bash
nsyte ci                                      # prints an nbunksec
git config --global preview.nbunksec <value>  # stores it
```

That needs approval in your signer app. A `nostr.nsec` in git config or a `NSITE_SEC` environment variable also work, and run unattended. ngit's own `nostr.bunker-uri` does not, because it carries no secret parameter for a second client to connect with.

## Dependencies

- `git`, [`ngit`](https://gitworkshop.dev/ngit), [`nsyte`](https://github.com/sandwichfarm/nsyte)
- Node 20.1 or newer

## Options

| | |
|---|---|
| `--live` | publish and comment, instead of only reporting what would happen |
| `--pr <nevent\|event-id>` | pick the pull request explicitly instead of matching the branch name |
| `--dir <folder>` | publish this folder instead of detecting `out`, `dist` or `build` |
| `--build "<command>"` | run this instead of the detected package manager's build script |
| `--allow-dirty` | publish even when the tree does not match the pushed commit |
| `--no-comment` | publish without commenting on the pull request |
| `--undeploy` | ask the relays and storage servers to drop this preview. They may keep copies |

`--dir` and `--build` cover anything the lockfile check cannot: a project outside the JavaScript ecosystem, or an app that lives in a subfolder of a larger repo.

```bash
node path/to/preview.mjs --build "cd ui && pnpm install && pnpm build" --dir ui/out
```

With no lockfile at the repo root the tool skips its own install, so `--build` has to do it.

## Notes

Static output only. Assets have to resolve from the root, so a build configured for a subpath such as `base: '/repo/'` will not load. There is no backend behind it either, so a UI that calls an API will render, but those calls go to whatever url was baked into the build.

A live run prints the preview url on stdout and everything else on stderr, so `URL=$(node path/to/preview.mjs --live)` captures just the link.

The url is fixed by your signing key and the pull request, so rerunning the tool republishes to the same link. A push on its own does not update it. Anyone else previewing the same pull request gets a different url, because their key is part of the hostname.

Any nsite gateway serves the same site, so swapping the `.nsite.lol` suffix reaches it through a different one.

## License

MIT
