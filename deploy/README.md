# Deploying quire-translator on Proxmox

Runs as **its own container** on a **non-common, configurable port** (default `48217`).
Job state (resume) and the **household library** persist on volumes, so a restart
continues in-flight work and never re-translates a book the household already has.

> Posture: a private homelab on the household LAN. No auth; keep it on the trusted LAN
> behind the Proxmox firewall, never port-forwarded to the public internet. The only
> egress is the user-initiated DeepSeek call. The shared household API key lives only in
> the container env / `.env` and is never logged.

## Choosing the port

Default `48217`. Override `PORT` consistently:

- Docker: `PORT=50001 docker compose up -d`
- LXC: `PORT=50001 ./deploy/proxmox-install.sh`

## Path 1 — native Proxmox LXC, one-shot (recommended)

Run on the **Proxmox host** (PVE shell) as root. `proxmox-install.sh` is self-contained
(it clones the repo itself), so it pastes straight into the console. The repo is private,
so pass a `repo`-scoped `GH_TOKEN`:

```bash
GH_TOKEN=ghp_xxx CTID=150 PORT=48217 PROVIDER_API_KEY=sk-deepseek \
  bash -c "$(curl -fsSL -H 'Authorization: token ghp_xxx' \
    https://raw.githubusercontent.com/karsai20/quire-translator/main/deploy/proxmox-install.sh)"
```

It creates an unprivileged Debian LXC, installs Node, clones to `/opt/quire-translator`,
writes `.env`, runs `npm install && npm run build`, prepares the Next.js standalone
output, and enables the `quire-translator` systemd service (`Restart=always`). The token
is scrubbed from the saved git remote. On success it prints the URL.

Overrides: `CTID`, `PORT`, `CORES`, `MEMORY_MB`, `DISK_GB`, `BRIDGE`, `STORAGE`,
`IPCONFIG` (`dhcp` or a CIDR) + `GATEWAY`, `BRANCH`, `NODE_MAJOR`, `COST_CEILING_USD`,
`TRANSLATION_REFINE`.

Manage it:

```bash
pct exec <CTID> -- journalctl -u quire-translator -f      # logs
pct exec <CTID> -- systemctl restart quire-translator     # restart
# Update: re-pull, rebuild, restart
pct exec <CTID> -- bash -lc 'cd /opt/quire-translator && git pull && npm install \
  && npm run build && cp -r .next/static .next/standalone/.next/static \
  && systemctl restart quire-translator'
```

Data lives at `/opt/quire-translator/data/{jobs,library}` — back it up with your Proxmox data.

## Path 2 — Docker (a Proxmox Docker VM, or any host)

```bash
git clone git@github.com:karsai20/quire-translator.git && cd quire-translator
cp .env.example .env          # set PROVIDER_API_KEY (optional), PORT, COST_CEILING_USD
docker compose up -d --build  # -> http://<host>:48217
```

`jobs` and `library` are named volumes, so `docker compose restart` keeps resume + the
household library intact.

## Firewall

Open the port to the LAN only:

```bash
# inside the LXC (or via the Proxmox firewall)
ufw allow from 192.168.0.0/16 to any port 48217 proto tcp
```
