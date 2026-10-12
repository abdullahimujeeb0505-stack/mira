---
name: Partial pnpm installs
description: Recover local TypeScript checks when a Replit package-proxy failure leaves a partial pnpm store.
---

A failed pnpm install can leave CLI packages under `node_modules/.pnpm` while workspace `.bin` links remain absent. When the package files exist, invoking their local entrypoints directly can still run tests and typechecks without another install. TypeScript may also need an explicit `--typeRoots` pointing at the cached `@types/node` package if workspace links are missing.

**Why:** Replit's package proxy can interrupt an install after many packages have been fetched, while leaving enough of the virtual store to run checks.

**How to apply:** Check whether the needed CLI package and its dependencies exist in `.pnpm` before concluding checks cannot run. Do not retry installation unless the user authorizes it.
