"""Bounded Factory Droid subprocess. The provider never receives database tokens."""
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import tempfile
import time

from .matching import build_prompt, MAX_OUTPUT_BYTES


class ProviderError(RuntimeError):
    pass


class FactoryProvider:
    model_run = 'LIVE'

    def __init__(self, *, api_key: str, model: str, executable='droid', timeout=120):
        if not api_key or not model:
            raise ProviderError('Set FACTORY_API_KEY and FACTORY_MODEL_ID before starting the matching worker')
        resolved = shutil.which(executable)
        if not resolved:
            raise ProviderError('Droid executable missing; use the matching Docker service or set DROID_EXEC_PATH')
        if not 0 < timeout <= 600:
            raise ValueError('Provider timeout must be between 0 and 600 seconds')
        self.executable, self.api_key, self.model, self.timeout = resolved, api_key, model, timeout

    def generate(self, context, schema, *, cancel):
        with tempfile.TemporaryDirectory(prefix='afterhours-matching-') as directory:
            folder = Path(directory)
            prompt = folder / 'prompt.txt'
            prompt.write_text(build_prompt(context, schema))
            # A fresh home/cwd avoids inheriting user MCP integrations, project
            # instructions, sessions or DB credentials. Factory requires a nonempty
            # allowlist: only its plan bookkeeping tool is selected. File, shell,
            # web, tool-discovery and external-action tools are excluded.
            env = {key: os.environ[key] for key in ('PATH', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
                'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY') if key in os.environ}
            env.update(HOME=directory, FACTORY_API_KEY=self.api_key)
            command = [self.executable, 'exec', '--output-format', 'json', '--only-tools', 'TodoWrite',
                       '--disable-builtin-skills', '--model', self.model, '--file', str(prompt)]
            with (folder / 'stdout').open('w+b') as stdout, (folder / 'stderr').open('w+b') as stderr:
                if cancel.is_set():
                    raise ProviderError('Matching inference cancelled')
                process = subprocess.Popen(command, cwd=directory, env=env, stdin=subprocess.DEVNULL,
                    stdout=stdout, stderr=stderr, start_new_session=True)
                deadline = time.monotonic() + self.timeout
                try:
                    while process.poll() is None:
                        if cancel.is_set():
                            raise ProviderError('Matching inference cancelled')
                        if time.monotonic() >= deadline:
                            raise ProviderError('Factory matching inference timed out')
                        if max(os.fstat(stdout.fileno()).st_size, os.fstat(stderr.fileno()).st_size) > 2 * MAX_OUTPUT_BYTES:
                            raise ProviderError('Factory output exceeded its size limit')
                        cancel.wait(0.05)
                    if cancel.is_set():
                        raise ProviderError('Matching inference cancelled')
                    if process.returncode:
                        # Provider stderr may contain prompts or credentials. Never log it.
                        raise ProviderError(f'Factory exited unsuccessfully (code {process.returncode})')
                    stdout.seek(0)
                    raw = stdout.read(2 * MAX_OUTPUT_BYTES + 1)
                    if len(raw) > 2 * MAX_OUTPUT_BYTES:
                        raise ProviderError('Factory output exceeded its size limit')
                    try:
                        envelope = json.loads(raw)
                        if not isinstance(envelope, dict) or envelope.get('is_error') is not False:
                            raise ValueError('unsuccessful result')
                        result = json.loads(envelope['result'])
                        if not isinstance(result, dict):
                            raise ValueError('expected output object')
                        return result
                    except (KeyError, TypeError, ValueError) as error:
                        raise ProviderError('Factory returned an invalid JSON result') from error
                finally:
                    if process.poll() is None:
                        os.killpg(process.pid, signal.SIGKILL)
                    process.wait()
