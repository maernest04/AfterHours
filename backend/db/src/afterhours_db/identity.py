"""Server-side identity files. Owner credentials are used only during bootstrap."""
import os
import re
import subprocess

from .client import SpacetimeClient
from .config import DatabaseConfig, spacetime_binary


def service_client(role: str, config: DatabaseConfig, *, create: bool = False, persistent: bool = False) -> SpacetimeClient:
    if role not in ('gateway', 'worker'):
        raise ValueError('Role must be gateway or worker')
    path = config.secrets_dir / f'{role}.token'
    if not path.exists():
        if not create:
            raise RuntimeError('Service token missing; run afterhours-db bootstrap')
        with SpacetimeClient(config.uri, config.database) as anonymous:
            credentials = anonymous.create_identity()
        path.parent.mkdir(parents=True, exist_ok=True)
        try:
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        except FileExistsError:
            pass
        else:
            with os.fdopen(fd, 'w') as stream:
                stream.write(credentials['token'])
    token = path.read_text().strip()
    if not token:
        raise RuntimeError(f'Empty service token file: {path}')
    if persistent:
        from .websocket import SpacetimeConnection
        return SpacetimeConnection(config.uri, config.database, token=token)
    return SpacetimeClient(config.uri, config.database, token=token)


def owner_token() -> str:
    output = subprocess.check_output([spacetime_binary(), 'login', 'show', '--token'], text=True)
    match = re.search(r'eyJ[\w.-]+', output)
    if not match:
        raise RuntimeError('No CLI owner token; publish the local database first')
    return match[0]


def bootstrap(config: DatabaseConfig):
    with service_client('gateway', config, create=True) as gateway, \
         service_client('worker', config, create=True) as worker, \
         SpacetimeClient(config.uri, config.database, token=owner_token()) as owner:
        owner.call_reducer('configure_settings', [config.company_id, 'USD',
            ['6100', 'Contractor Services Expense'], ['2105', 'Accrued Liabilities'], '2026.10-demo'])
        owner.call_reducer('configure_job_policy', [int(os.getenv('JOB_LEASE_SECONDS', '30')),
                                                   int(os.getenv('JOB_MAX_ATTEMPTS', '3'))])
        for client, role in ((gateway, 'GATEWAY'), (worker, 'WORKER')):
            identity = client.identity()
            # SATS-JSON encodes identity as a product containing a formatted u256 hex string.
            owner.call_reducer('register_service_identity',
                               [['0x' + identity.removeprefix('0x')], role, f'Python {role.lower()}'])
    print(f'[bootstrap] {config.database}: configured company {config.company_id} and gateway/worker identities')
