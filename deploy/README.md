# Deploying quire-translator on Proxmox

This app runs as **its own container** on a **non-common, configurable port**
(default `48217`). Job state is persisted so a restart **resumes** in-flight
translations instead of restarting them. Two paths are supported.

> Posture: the app has **no authentication** and is meant for a **trusted LAN**
> behind the Proxmox firewall. The only network egress is the user-initiated DeepSeek
> call (the book text is sent to DeepSeek when a key is configured). The API key is
> read only from `.env` / env vars and is never logged.

## Choosing the port

Default is `48217` (uncommon, outside the common-service range, below the ephemeral
range). To change it, set `PORT` everywhere consistently:

- Docker: `PORT=50001 docker compose up -d` (publishes host `50001`).
- LXC: `PORT=50001 ./deploy/proxmox-lxc-setup.sh`.

## Path 1 — Docker container (a Proxmox Docker VM or Docker-in-LXC)

```bash
cp .env.example .env        # set PROVIDER_API_KEY (optional), COST_CEILING_USD
docker compose up -d --build
# -> http://<docker-host>:48217
```

- `jobs/` lives on the named volume `quire-jobs`, so `docker compose restart` resumes.
- Without a `PROVIDER_API_KEY`, it runs the zero-cost **fake** provider (a dry run that
  exercises the whole pipeline without calling any API).

## Path 2 — native Proxmox LXC, one-shot (recommended)

Run on the **Proxmox host** (PVE shell), as root. `proxmox-install.sh` is fully
self-contained — it clones the repo itself, so you can paste it straight into the
console. The repo is private, so pass a `repo`-scoped `GH_TOKEN`:

```bash
GH_TOKEN=ghp_xxx CTID=150 PORT=48217 PROVIDER_API_KEY=sk-... \
  bash -c "$(curl -fsSL -H 'Authorization: token ghp_xxx' \
    https://raw.githubusercontent.com/karsai20/quire-translator/main/deploy/proxmox-install.sh)"
```

It creates an unprivileged Debian LXC, installs Bun, clones to `/opt/quire-translator`,
writes `.env`, builds the web bundle, and enables a systemd service
(`quire-translator.service`, `Restart=always`). On success it prints the URL. The token
is scrubbed from the saved git remote.

Overrides: `CTID`, `PORT`, `CORES`, `MEMORY_MB`, `DISK_GB`, `BRIDGE`, `STORAGE`,
`IPCONFIG` (`dhcp` or a CIDR) + `GATEWAY`, `BRANCH`, `COST_CEILING_USD`.

### Offline variant (repo already on the host)

If the repo is already checked out on the Proxmox host (no GitHub access from there),
`proxmox-lxc-setup.sh` does the same thing but **pushes the local source** into the LXC
instead of cloning:

```bash
CTID=150 PORT=48217 PROVIDER_API_KEY=sk-... ./deploy/proxmox-lxc-setup.sh
```

Useful commands:

```bash
pct exec <CTID> -- journalctl -u quire-translator -f     # logs
pct exec <CTID> -- systemctl restart quire-translator    # restart
# Update the app: re-run the script — it re-pushes source and restarts.
```

## Firewall

Open the chosen port to the LAN only. Example with the Proxmox firewall (or `ufw`
inside the LXC):

```bash
# inside the LXC
ufw allow from 192.168.0.0/16 to any port 48217 proto tcp
```

Do not expose the port to the public internet — there is no auth.
