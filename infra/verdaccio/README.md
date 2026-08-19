# Praxis private registry on Windows Docker

> 这是一份运维文档，不是普通用户的首选安装路径。只有负责 Windows 私有 Registry 的管理员需要部署
> 本页服务；普通开发者从源码运行 `npm run install:local`。当前 `@praxis/*` 包不发布到 npmjs。

## 开始前 / Before you start

你需要 Windows Docker、可持久化 Named Volume、专用发布账号，以及能够访问该主机的
`praxis-private-registry` Self-hosted Runner。先确认 `127.0.0.1:4873` 只对本机开放；若要跨主机访问，
必须另行设计 TLS、身份认证和网络边界，当前配置不能直接暴露到公网。

首次操作顺序：启动并检查 Ping → 创建唯一发布账号 → 配置 Repository Variable/Secret → 手工触发一次
发布 → 验证七个包版本和 Integrity → 做一次停止状态备份。删除 Named Volume 会同时删除包和认证库。

This deployment exposes Verdaccio only at `http://127.0.0.1:4873/`. It is the
only supported publication endpoint for `@praxis/*`; those packages never
proxy to npmjs. Unscoped third-party dependencies may still use the npmjs
uplink.

The image is pinned to Verdaccio `6.9.0` and its multi-platform image digest.
Update both only after reviewing the official release and resolving the new
digest with:

```powershell
docker buildx imagetools inspect verdaccio/verdaccio:<version>
```

## Start and inspect

From the repository root:

```powershell
docker compose -f infra/verdaccio/docker-compose.yml config
docker compose -f infra/verdaccio/docker-compose.yml pull
docker compose -f infra/verdaccio/docker-compose.yml up -d
docker compose -f infra/verdaccio/docker-compose.yml ps
Invoke-RestMethod http://127.0.0.1:4873/-/ping
```

The registry storage and htpasswd database live in the named Docker volume
`praxis-verdaccio-data`. A normal shutdown preserves them:

```powershell
docker compose -f infra/verdaccio/docker-compose.yml down
```

Do not use `docker compose down -v` during normal operation. The `-v` option
deletes every published package and the authentication database.

## Bootstrap the publisher

The configuration permits exactly one account. Create it once from the Windows
host:

```powershell
npm adduser --auth-type=legacy --registry http://127.0.0.1:4873/
```

Use a dedicated automation identity, not a personal npmjs credential. Store its
token as the GitHub Actions secret `PRAXIS_NPM_TOKEN`; never commit it or leave
it in the self-hosted runner user's `.npmrc`. Set the repository Actions
variable:

```text
PRAXIS_NPM_REGISTRY_URL=http://127.0.0.1:4873/
```

The private publication workflow creates and removes a temporary npm user
configuration for every run.

## Local package installation

Opt into the private scope without changing the default registry for
third-party dependencies:

```powershell
npm config set @praxis:registry http://127.0.0.1:4873/ --location=user
npm login --auth-type=legacy --registry http://127.0.0.1:4873/
npm install --global @praxis/cli
```

Remove the local scope mapping when it is no longer needed:

```powershell
npm config delete @praxis:registry --location=user
```

## Logs, backup, and restore

Inspect logs:

```powershell
docker compose -f infra/verdaccio/docker-compose.yml logs --tail 200 verdaccio
```

Create a stopped, consistent backup:

```powershell
docker compose -f infra/verdaccio/docker-compose.yml stop verdaccio
docker run --rm --volume praxis-verdaccio-data:/source:ro --volume "${PWD}:/backup" alpine:3.22 tar -czf /backup/praxis-verdaccio-data.tgz -C /source .
docker compose -f infra/verdaccio/docker-compose.yml start verdaccio
```

Store the backup outside the public repository. To restore, stop Verdaccio,
restore the archive into a new empty named volume, then start the service and
verify `/-/ping` plus all expected package versions before allowing
publication.

For token rotation, create a replacement token while the account remains
valid, update `PRAXIS_NPM_TOKEN`, run the manually dispatched private workflow,
and only then revoke the old token. If the sole account is lost, restore the
volume backup or deliberately reset the htpasswd database while Verdaccio is
stopped.

## English summary

This localhost-only Verdaccio instance is the supported private publication
target for `@praxis/*`. Bootstrap one automation account, store its token only
as the Actions secret, keep the scope mapping separate from npmjs, and take
stopped-volume backups. Never expose the provided HTTP configuration directly
to an untrusted network, and never use `docker compose down -v` during normal
operation.
