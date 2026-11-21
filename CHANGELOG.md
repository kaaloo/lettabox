# Changelog

## [0.2.0](https://github.com/kaaloo/lettabox/compare/lettabox-v0.1.0...lettabox-v0.2.0) (2026-11-21)


### Features

* **auth:** launch interactive letta login in TTY mode and fail fast on HTTP 401/403 ([1fd4c93](https://github.com/kaaloo/lettabox/commit/1fd4c9312903587dc4edde7b2512ca85b0ba2d9e))
* **auth:** launch interactive letta login in TTY mode when unauthenticated and fail fast on HTTP 401/403 ([a204391](https://github.com/kaaloo/lettabox/commit/a204391921d6b31b422a935d9115027f7ab78dbe))
* **cli:** add --version, --computer-name, and --lifecycle-output jsonl for macOS menubar ([2a5faac](https://github.com/kaaloo/lettabox/commit/2a5faacce8df773f44ad1328fe2836578cc32cf5))
* **cli:** add --version, --computer-name, and --lifecycle-output jsonl for macOS menubar ([fde57df](https://github.com/kaaloo/lettabox/commit/fde57dfffbbee7b61327a24863bed217ce828fa2))
* **cli:** rebrand to lettabox with one-line CLI, managed control-plane, and /status endpoint ([3927f05](https://github.com/kaaloo/lettabox/commit/3927f051dac2f7c04c1404eef92787d41e39d24e))
* **cli:** rebrand to lettabox with one-line CLI, managed control-plane, and /status endpoint ([5c16c37](https://github.com/kaaloo/lettabox/commit/5c16c3782b01ac07bf287ad198be9c1014460e27))
* **m2:** implement Milestone 2 passthrough proxy with mock relay tests ([aca9b15](https://github.com/kaaloo/lettabox/commit/aca9b15966cc60b16f8785ab6d6feca5a76766fa))
* **m3:** implement envelope router, worker pool, request correlation, and event_seq rewriting ([d5b7c01](https://github.com/kaaloo/lettabox/commit/d5b7c013cb46198b3d13eb3a849f1fb5d1af9b74))
* **m4:** add Microsandbox (msb) provider with host-side secret injection and idle reaping ([5788f2a](https://github.com/kaaloo/lettabox/commit/5788f2aec4afbda526d4f46b397cbe037462a29a))
* **m4:** implement lazy Docker/gVisor sandbox spawning, idle reaping, and container image ([9644865](https://github.com/kaaloo/lettabox/commit/9644865353fd42aa0b21deef0c4190a7e2ae65a6))
* **msb:** default to official ghcr.io/letta-ai/letta-code:latest with inline capability-token bootstrap ([4d33432](https://github.com/kaaloo/lettabox/commit/4d334325feccb2aa48be7fd417c9cd51f54ae7ee))
* **msb:** pre-warm 1 standby microVM before connecting upstream and log spawn phase timings ([42f3310](https://github.com/kaaloo/lettabox/commit/42f3310abe09ad798ef9622a1961398239bee006))
* **msb:** pre-warm 1 standby microVM before connecting upstream and log spawn phase timings ([58ca71f](https://github.com/kaaloo/lettabox/commit/58ca71ff9abd7469cc3bf5a3be8dfc5f023d22d4))
* **register:** send host machine metadata with 📦 emoji prefix for Lettabox status line ([92af64e](https://github.com/kaaloo/lettabox/commit/92af64eba50a01dc50d3b779d1fcaf6b17d3992b))
* **register:** send host machine metadata with 📦 emoji prefix for Lettabox status line ([7f301fc](https://github.com/kaaloo/lettabox/commit/7f301fc6c4e10317672c9a93ea4f08b109e13647))
* use Microsandbox TypeScript SDK ([e37d496](https://github.com/kaaloo/lettabox/commit/e37d496eda519caf9f630e0db459f574a928fe27))
* use Microsandbox TypeScript SDK ([46c7be6](https://github.com/kaaloo/lettabox/commit/46c7be607bbfdfd5465c55e4436f0a1dc63406c6))


### Bug Fixes

* **ci:** exclude generated changelog from Biome ([45cd534](https://github.com/kaaloo/lettabox/commit/45cd534a4c92cff749ec5d7822ba98a4c39be7da))
* **ci:** exclude generated changelog from Biome ([1f217ed](https://github.com/kaaloo/lettabox/commit/1f217ed23ed5259d5ac6dbba3bf13d17cfe48254))
* **cli:** address Codex review findings (stdout drain, disconnect readiness, EADDRINUSE cleanup) ([6f9e1f1](https://github.com/kaaloo/lettabox/commit/6f9e1f1c44e49cad2360e382f96a61d4e55890df))
* **cli:** monitor unexpected managed control-plane exit and shut down cleanly ([8f0d616](https://github.com/kaaloo/lettabox/commit/8f0d616936023299c9cfd195b310a7228bb3c440))
* **cli:** preserve aggregate microVM busy state across upstream reconnects ([3e8d0ff](https://github.com/kaaloo/lettabox/commit/3e8d0ff6c03ac8f6c3e52ca736437b29e945f98f))
* **msb:** check inFlightSpawns before claiming warm standby to preserve concurrent acquisition deduplication ([bad375c](https://github.com/kaaloo/lettabox/commit/bad375cb9ea91768bae34c36417baa9c181c7a68))
* **msb:** install and pin SDK-matching microsandbox runtime before connecting upstream ([2a255f5](https://github.com/kaaloo/lettabox/commit/2a255f5c1f42bd515fce3a663bc0b98ac0f6002f))
* **msb:** install and pin SDK-matching microsandbox runtime under MSB_HOME before connecting upstream ([9e8e348](https://github.com/kaaloo/lettabox/commit/9e8e3488384de10a72eb8a64b67e45d1dcb65f82))
* **msb:** launch guest letta server via sandbox.execDetached() and log guest diagnostics ([9716ea1](https://github.com/kaaloo/lettabox/commit/9716ea1aeddf093493b810d5482a293715ad483b))
* **msb:** launch guest server via sandbox.execDetached() and log guest diagnostics on init failure ([fdca887](https://github.com/kaaloo/lettabox/commit/fdca887f3c68d5f73927e0ed67297ee535b64d2d))
* **msb:** pre-pull OCI image during ensureReady() before going green and signal busy while spawning ([5dbabc7](https://github.com/kaaloo/lettabox/commit/5dbabc7eb6bb43d18e6e6a2666a83e06cf09a76b))
* **msb:** pre-pull OCI image during ensureReady() before going green and signal busy while spawning ([ed877d7](https://github.com/kaaloo/lettabox/commit/ed877d701b36a0902e7124832bf91bb1f75e256e))
* **msb:** propagate MSB_HOME/MSB_PATH/MSB_LIBKRUNFW_PATH to native C environ in Bun ([616c43a](https://github.com/kaaloo/lettabox/commit/616c43a6dc560d0701759c80aee9ef0143ce2f7d))
* **msb:** propagate MSB_HOME/MSB_PATH/MSB_LIBKRUNFW_PATH to native C environ via bun:ffi setenv ([52bc9af](https://github.com/kaaloo/lettabox/commit/52bc9afeceee9778c2024ac1c37d059b862644bd))
* **msb:** require open WebSocket connection before claiming a warm standby microVM ([015a102](https://github.com/kaaloo/lettabox/commit/015a1028427e1ee8ab76c33964a716946c197642))
* **msb:** retry failed warm standby refills with exponential backoff and recover on cold spawns ([414ba96](https://github.com/kaaloo/lettabox/commit/414ba96f138a32b27990af741989bca37d04845a))
* **sandbox:** guard busy turns from reaping, evict dead microVMs, and route top-level conversation_id ([7b3336a](https://github.com/kaaloo/lettabox/commit/7b3336a6fcc6d14b33adc586a7e7bbd1f136908f))
* **sandbox:** guard busy turns from reaping, evict dead microVMs, and route top-level conversation_id ([b978f20](https://github.com/kaaloo/lettabox/commit/b978f20174d938253fede02032d5ee0dcec8ea28))
