# Maintenance

## Backups
```bash
docker-compose down
tar -czf framecomment-backup.tar.gz \
  /var/lib/docker/volumes/framecomment_postgres-data \
  /var/lib/docker/volumes/framecomment_uploads
```

If using bind mounts, back up your host paths instead.

## Updates
```bash
docker-compose pull
docker-compose up -d
```

For a specific tag:
```bash
docker pull dragosonisei/framecomment:latest
docker-compose up -d
```

Migrations run automatically on startup.

## Logs
```bash
docker-compose logs app
docker-compose logs worker
docker-compose logs -f
```

## Database management
```bash
# Access PostgreSQL
docker exec -it framecomment-postgres psql -U framecomment -d framecomment

# Backup
docker exec framecomment-postgres pg_dump -U framecomment framecomment > backup.sql

# Restore
docker exec -i framecomment-postgres psql -U framecomment framecomment < backup.sql
```

---
Navigation: [Home](Home) | [Features](Features) | [Installation](Installation) | [Platform Guides](Platform-Guides) | [Configuration](Configuration) | [Admin Settings](Admin-Settings) | [Usage Guide](Usage-Guide) | [Client Guide](Client-Guide) | [Security](Security) | [Maintenance](Maintenance) | [Troubleshooting](Troubleshooting) | [Screenshots](Screenshots) | [Contributing](Contributing) | [License](License)
