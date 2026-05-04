# Local development on Mac

This guide walks you through running FrameComment locally for development.
Hot reload is enabled — when you edit a file, the browser updates in ~1 second.

## One-time setup (~10 min)

### 1. Start postgres + redis in Docker

Open Terminal, then:

```bash
cd /Users/dragos/Downloads/FrameComment
docker compose -f docker-compose.dev.yml up -d
```

Wait ~15 seconds. Verify both are running:

```bash
docker ps
```

You should see `framecomment-dev-postgres` and `framecomment-dev-redis` both `(healthy)`.

### 2. Install Node dependencies

This downloads ~500 packages and takes 5-10 min the first time.

```bash
cd /Users/dragos/Downloads/FrameComment
npm install
```

You will see warnings — ignore them. Wait for the prompt to return.

### 3. Initialize the database

This creates all the tables, indexes, and seeds the first admin user:

```bash
npx prisma migrate deploy
```

You should see something like `All migrations have been successfully applied`.

### 4. Start the Next.js dev server

```bash
npm run dev
```

Wait ~10-20 seconds for the first compile. You'll see:

```
   ▲ Next.js 16.1.6
   - Local:        http://localhost:4321
   - Environments: .env.local
 ✓ Ready in 12.3s
```

Open `http://localhost:4321` in your browser. Log in with:

- Email: `dragosonisei@gmail.com`
- Password: `devpassword123`

## Daily workflow

### Start everything

```bash
cd /Users/dragos/Downloads/FrameComment
docker compose -f docker-compose.dev.yml up -d
npm run dev
```

### Edit a file

Open any file in `src/` with your editor (VS Code, etc.).
Change a string, save (Cmd+S). Browser auto-reloads in <1 second.

### Stop everything

In the terminal running `npm run dev`: press `Ctrl+C`.

To also stop postgres/redis (free RAM):

```bash
docker compose -f docker-compose.dev.yml down
```

### Wipe the local database (start fresh)

```bash
docker compose -f docker-compose.dev.yml down -v
docker compose -f docker-compose.dev.yml up -d
npx prisma migrate deploy
```

## Worker (optional)

The worker handles video transcoding and email queues. For most UI changes
you do not need to run it. If you do:

In a **second terminal**:

```bash
cd /Users/dragos/Downloads/FrameComment
npm run worker
```

## Publishing changes

When your local changes look good:

```bash
git add .
git commit -m "feat: short description of what changed"
git push origin main
```

Then bump the version and tag a release (see [docs/RELEASING.md](docs/RELEASING.md)):

```bash
npm version patch     # 1.0.0 → 1.0.1
echo "1.0.1" > VERSION
git add package.json package-lock.json VERSION
git commit -m "chore(release): v1.0.1"
git tag -a v1.0.1 -m "FrameComment v1.0.1"
git push origin main
git push origin v1.0.1
```

GitHub Actions builds the new Docker image (`dragosonisei/framecomment:1.0.1`)
in ~15 minutes. Then on TrueNAS, edit the app YAML and change `:1.0.0` to
`:1.0.1`, hit Save.

## Troubleshooting

**`docker compose` says command not found**
Docker Desktop is not running. Open Docker Desktop from Applications, wait
for the whale icon at the top to be steady (not animated).

**Port 5432 already in use**
You have another postgres running on your Mac. Either stop it, or edit
`docker-compose.dev.yml` and change `127.0.0.1:5432:5432` to
`127.0.0.1:5433:5432`, then update `DATABASE_URL` in `.env.local` to use
port 5433.

**`npm install` fails with permission errors**
Don't use `sudo`. If it complains, try `npm cache clean --force` first.

**Browser shows blank page or 500 error**
Check the terminal where `npm run dev` is running — Next.js prints errors
there with file:line links.

**Database connection errors**
Make sure postgres is healthy: `docker ps` should show `(healthy)`.
If not, restart: `docker compose -f docker-compose.dev.yml restart`.
