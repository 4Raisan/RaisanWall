import { handle } from '@astrojs/cloudflare/handler';
import { archiveExpiredOffers } from './lib/offer-lifecycle';
import type { Env } from './lib/types';

export default {
  fetch: handle,
  async scheduled(_controller: ScheduledController, env: Env) {
    await archiveExpiredOffers(env);
  },
};
