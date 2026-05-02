# FrameComment — TrueNAS SCALE Custom Catalog

This directory contains a [TrueNAS SCALE](https://www.truenas.com/truenas-scale/)
**custom catalog** for FrameComment, intended for SCALE **24.10 "Electric Eel"
or newer** (Docker-based Apps).

> **Status:** Starting skeleton. Suitable for installation as a *private*
> catalog on your own TrueNAS instance from day one. A polished, public
> submission to the official TrueNAS catalog is planned for FrameComment 1.1.x.

## Two ways to install FrameComment on TrueNAS SCALE

### Option A — Quick: install as Custom App (recommended for first run)

You do not need this catalog for the basic install. Use SCALE's built-in
*Custom App* feature:

1. In SCALE, go to **Apps → Discover → Custom App**.
2. Choose *Install via YAML* and paste the contents of
   [`docker-compose.truenas.yml`](../docker-compose.truenas.yml) at the project root.
3. Set the environment variables required by `.env.example` (passwords and
   secrets) in the Custom App form.
4. Adjust the volume host paths from `/mnt/tank/apps/framecomment/...` to
   match your pool layout.
5. Click *Install*.

### Option B — This catalog: install via a private catalog

If you want a configuration form (with auto-generated secrets, host-path
pickers, S3 toggles, etc.) instead of raw YAML, add this catalog:

1. Push this repository to GitHub.
2. In SCALE, go to **Apps → Discover → Manage Catalogs → Add Catalog**.
3. Use these values:

   | Field | Value |
   |---|---|
   | **Catalog Name** | `framecomment` |
   | **Repository** | `https://github.com/DragosOnisei/FrameComment` |
   | **Preferred Trains** | `community` |
   | **Branch** | `main` |
   | **Label** | `FrameComment` |
   | **Catalog location** | `truenas-catalog` |

4. SCALE will sync the catalog. FrameComment will appear under
   **Apps → Discover → community train → FrameComment**.

## Catalog layout

```
truenas-catalog/
├── README.md                       (this file)
├── catalog.json                    (index of trains and apps)
└── community/
    └── framecomment/
        ├── app.yaml                (app-level metadata)
        ├── item.yaml               (latest version pointer)
        ├── icon.png                (placeholder; replace with real icon)
        ├── README.md
        └── 1.0.0/
            ├── README.md
            ├── app.yaml            (version-specific metadata)
            ├── metadata.yaml
            ├── questions.yaml      (configuration form rendered by SCALE)
            ├── ix_values.yaml      (default values)
            └── templates/
                └── docker-compose.yaml  (the deployment template)
```

## Working on the catalog

When releasing a new version of FrameComment, copy the latest `1.x.y/` folder
to a new `1.x.(y+1)/`, bump versions and image tag inside, and update the
`item.yaml` and `app.yaml` `latest_version` field. See
[`docs/RELEASING.md`](../docs/RELEASING.md) for the complete release flow.

## License

Same license as the parent project: AGPL-3.0-only. See [LICENSE](../LICENSE).
