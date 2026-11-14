# RaisanWall

RaisanWall is a personal post wall for sharing finds, projects, and time-limited offers. Readers see the public wall and RSS feed. The owner manages posts in a private Studio, and authorized agents can publish through an API. Expired offers are archived automatically.

The app uses Astro on Cloudflare Workers, with D1 for posts, R2 for media, and KV for sessions.

## Run locally

```sh
npm ci
npm run setup
npm run dev
```

Open the wall at http://127.0.0.1:4321 and the editor at http://127.0.0.1:4321/studio. Setup applies the local database migrations, seeds sample posts, and writes local credentials to the ignored `local-access.txt` file.

Run `npm run build` and `npm test` to check the project.

## Deploy to Cloudflare Workers

1. Create D1, R2, and KV resources in Cloudflare.
2. In the Wrangler configuration, set the database name and ID for DB, the bucket name for MEDIA, and the namespace ID for SESSION.
3. Configure ADMIN_PASSWORD, AGENT_TOKEN, and SESSION_SECRET as Worker secrets.
4. Apply migrations with `npx wrangler d1 migrations apply DB --remote`, then run `npm run deploy`.
