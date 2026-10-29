/// <reference types="astro/client" />
/// <reference types="@astrojs/cloudflare" />

declare namespace App {
  interface Locals {
    env: import('./lib/types').Env;
  }
}
