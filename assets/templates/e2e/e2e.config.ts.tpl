// Written by `looprch e2e init`. Yours to edit; Looprch runs it with `e2e run --config`.
import { existsSync } from 'node:fs';
import type { E2EConfig } from 'e2e';
import { web } from '@e2e-dev/web';
{{provider_import}}

// Keys and settings live in .env.e2e (gitignored). A variable exported in the shell wins.
if (existsSync('.env.e2e')) process.loadEnvFile('.env.e2e');

export default {
{{agents}}  targets: [{
    engine: web(),
    app: {
      url: process.env.APP_URL || '{{url}}',
{{command}}    },
  }],
} satisfies E2EConfig;
