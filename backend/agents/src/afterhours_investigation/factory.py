from contextlib import asynccontextmanager
import os
from pathlib import Path
import shutil
from tempfile import TemporaryDirectory

from droid_sdk import JsonSchema, Runtime, Session, SessionConfig

from .handler import INSTRUCTIONS


@asynccontextmanager
async def factory_session():
    executable = os.getenv('DROID_EXEC_PATH') or 'droid'
    if not shutil.which(executable):
        raise RuntimeError('Droid CLI is missing; install and authenticate it before running LIVE jobs')
    # Droid treats an empty allowlist as unrestricted; this ID has no implementation.
    config = SessionConfig(system_prompt=INSTRUCTIONS, restrict_tools={'afterhours-no-native-tools'},
                           auto_reject_permission_requests=True, disable_builtin_skills=True)
    with TemporaryDirectory(prefix='afterhours-investigation-') as directory:
        async with Session(cwd=Path(directory), model=os.getenv('FACTORY_MODEL_ID') or None,
                           runtime=Runtime(executable=executable), config=config) as session:
            catalog = await session.list_tools()
            await session.update_settings(disabled_tools={tool.id for tool in catalog})
            if any(tool.allowed for tool in await session.list_tools()):
                raise RuntimeError('Factory must disable all native/connected tools before investigation')

            async def decide(prompt, schema):
                async with session.stream(prompt, output=JsonSchema(schema), timeout=60) as stream:
                    async for _ in stream:
                        pass
                result = stream.result
                if not result.success or result.output is None:
                    raise RuntimeError(f'Factory investigation failed: {result.subtype}')
                return result.output

            yield decide
