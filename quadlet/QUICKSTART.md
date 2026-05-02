# FrameComment Quadlet - Quick Start ($USER Setup)

## Overview

This setup deploys FrameComment using:
- **User:** $USER (UID 1000, GID 1000)
- **Data directory:** `/podman/framecomment`
- **Container configs:** `~/.config/containers/systemd`
- **Rootless Podman** with systemd user services

## Directory Structure

```
/podman/framecomment/
├── postgres-data/       # PostgreSQL database
├── redis-data/          # Redis cache
└── uploads/             # Video uploads and processed files

~/.config/containers/systemd/
├── framecomment-postgres.container
├── framecomment-redis.container
├── framecomment-app.container
├── framecomment-worker.container
└── framecomment-network.network
```

## Automated Installation (Recommended)

```bash
# 1. Copy quadlet directory to server (as $USER user)
scp -r quadlet/ $USER@server:/tmp/

# 2. SSH as $USER
ssh $USER@server

# 3. Move to permanent location
cd /tmp/quadlet

# 4. Run setup scripts
./setup-directories.sh     # Creates /podman/framecomment structure
./configure.sh            # Generate secrets & configure
./install.sh              # Install to systemd

# 5. Enable lingering (allows services to start on boot without login)
sudo loginctl enable-linger $USER

# 6. Start services
systemctl --user start framecomment-postgres.service
systemctl --user start framecomment-redis.service
systemctl --user start framecomment-app.service
systemctl --user start framecomment-worker.service

# 7. Enable auto-start
systemctl --user enable framecomment-postgres.service
systemctl --user enable framecomment-redis.service
systemctl --user enable framecomment-app.service
systemctl --user enable framecomment-worker.service
```

## Manual Installation

```bash
# 1. Create directory structure
sudo mkdir -p /podman/framecomment/{postgres-data,redis-data,uploads}
sudo chown -R 1000:1000 /podman/framecomment
sudo chmod 700 /podman/framecomment/postgres-data

# 2. Generate secrets
export POSTGRES_PASSWORD=$(openssl rand -base64 32)
export REDIS_PASSWORD=$(openssl rand -base64 32)
export ENCRYPTION_KEY=$(openssl rand -hex 32)
export JWT_SECRET=$(openssl rand -hex 32)
export JWT_REFRESH_SECRET=$(openssl rand -hex 32)
export SHARE_TOKEN_SECRET=$(openssl rand -hex 32)
# Optional: set for Cloudflare tunnel deployments
# export CLOUDFLARE_TUNNEL=true

# Save these somewhere safe!
echo "POSTGRES_PASSWORD=${POSTGRES_PASSWORD}" > ~/.framecomment-secrets
echo "REDIS_PASSWORD=${REDIS_PASSWORD}" >> ~/.framecomment-secrets
echo "ENCRYPTION_KEY=${ENCRYPTION_KEY}" >> ~/.framecomment-secrets
echo "JWT_SECRET=${JWT_SECRET}" >> ~/.framecomment-secrets
echo "JWT_REFRESH_SECRET=${JWT_REFRESH_SECRET}" >> ~/.framecomment-secrets
echo "SHARE_TOKEN_SECRET=${SHARE_TOKEN_SECRET}" >> ~/.framecomment-secrets
chmod 600 ~/.framecomment-secrets

# 3. Edit *.container files - replace all CHANGE_* placeholders

# 4. Install to systemd
mkdir -p ~/.config/containers/systemd
cp *.container *.network ~/.config/containers/systemd/
chmod 600 ~/.config/containers/systemd/*.container

# 5. Reload systemd
systemctl --user daemon-reload

# 6. Pull image
podman pull docker.io/dragosonisei/framecomment:latest

# 7. Enable lingering
sudo loginctl enable-linger $USER

# 8. Start services (see above)
```

## Verify Installation

```bash
# Check service status
systemctl --user status framecomment-*.service

# View logs
journalctl --user -u framecomment-app.service -f

# Check containers
podman ps

# Test application
curl http://localhost:4321/api/health

# Check data directories
ls -la /podman/framecomment/
```

## Common Commands

### Service Management

```bash
# Start all services
systemctl --user start framecomment-{postgres,redis,app,worker}.service

# Stop all services
systemctl --user stop framecomment-*.service

# Restart app only
systemctl --user restart framecomment-app.service

# Check status
systemctl --user status framecomment-*.service
```

### Logs

```bash
# Follow app logs
journalctl --user -u framecomment-app.service -f

# Follow worker logs
journalctl --user -u framecomment-worker.service -f

# Show last 100 lines
journalctl --user -u framecomment-app.service -n 100

# Show all service logs
journalctl --user -u framecomment-*.service -f
```

### Container Management

```bash
# List containers
podman ps

# Exec into container
podman exec -it framecomment-app /bin/sh

# View container logs directly
podman logs framecomment-app
```

## Backup

```bash
# Backup database
podman exec framecomment-postgres pg_dump -U framecomment framecomment > ~/backup-$(date +%Y%m%d).sql

# Backup uploads
tar czf ~/uploads-backup-$(date +%Y%m%d).tar.gz -C /podman/framecomment/uploads .

# Backup all data
sudo tar czf ~/framecomment-full-backup-$(date +%Y%m%d).tar.gz -C /podman framecomment/
```

## Restore

```bash
# Restore database
cat ~/backup-20250127.sql | podman exec -i framecomment-postgres psql -U framecomment framecomment

# Restore uploads
tar xzf ~/uploads-backup-20250127.tar.gz -C /podman/framecomment/uploads/
```

## Update Application

```bash
# Pull latest image
podman pull docker.io/dragosonisei/framecomment:latest

# Restart services
systemctl --user restart framecomment-app.service
systemctl --user restart framecomment-worker.service

# Check logs
journalctl --user -u framecomment-app.service -f
```

## Troubleshooting

### Services Won't Start

```bash
# Check systemd status
systemctl --user status framecomment-app.service

# Check detailed logs
journalctl --user -u framecomment-app.service -n 200

# Check if directories exist
ls -la /podman/framecomment/

# Check permissions
stat /podman/framecomment/postgres-data
# Should be owned by 1000:1000, mode 700
```

### Permission Denied Errors

```bash
# Fix ownership
sudo chown -R 1000:1000 /podman/framecomment

# Fix postgres permissions
sudo chmod 700 /podman/framecomment/postgres-data

# Verify
ls -la /podman/framecomment/
```

### Port Already in Use

```bash
# Check what's using the port
ss -tlnp | grep 4321

# Edit framecomment-app.container:
# PublishPort=5000:4321
```

### Database Connection Issues

```bash
# Check postgres service
systemctl --user status framecomment-postgres.service

# Check postgres logs
journalctl --user -u framecomment-postgres.service -n 50

# Check network
podman network inspect framecomment-internal
```

### Lingering Not Enabled

If services don't start on boot:

```bash
# Enable lingering
sudo loginctl enable-linger $USER

# Verify
loginctl show-user $USER | grep Linger
# Should show: Linger=yes
```

### Reset Everything (WARNING: Destroys Data!)

```bash
# Stop services
systemctl --user stop framecomment-*.service

# Remove containers
podman rm -f framecomment-postgres framecomment-redis framecomment-app framecomment-worker

# Backup data first!
sudo mv /podman/framecomment /podman/framecomment.old

# Remove data (CAREFUL!)
sudo rm -rf /podman/framecomment

# Recreate structure
./setup-directories.sh

# Reinstall
./install.sh

# Start services
systemctl --user start framecomment-*.service
```

## Key Differences from Docker Compose

| Feature | Docker Compose | Quadlet |
|---------|---------------|---------|
| Management | `docker compose up` | `systemctl --user start` |
| Logs | `docker logs` | `journalctl --user` |
| Auto-start | `restart: always` | `systemctl enable` + lingering |
| Updates | Manual pull | `podman auto-update` |
| Root required | Optional | No (rootless) |

## Important Notes

1. **Lingering must be enabled** for services to auto-start on boot:
   ```bash
   sudo loginctl enable-linger $USER
   ```

2. **All data is in `/podman/framecomment`** - backup this directory!

3. **Secrets are in `.container` files** - protect them:
   ```bash
   chmod 600 ~/.config/containers/systemd/*.container
   ```

4. **Container configs are user-specific** - installed in `~/.config/`

5. **Services run as $USER (1000:1000)** - no root needed

## Resources

- Full documentation: `README.md`
- Container definitions: `~/.config/containers/systemd/*.container`
- Data directories: `/podman/framecomment/*`
- Secrets file: `.secrets` (created by configure.sh)

## Support

For issues:
- Check logs: `journalctl --user -u framecomment-app.service -f`
- Verify permissions: `ls -la /podman/framecomment/`
- Check lingering: `loginctl show-user $USER | grep Linger`
- Ensure directories exist: `ls -la /podman/framecomment/`
