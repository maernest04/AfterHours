from contextlib import asynccontextmanager

from .bitdeer import BitdeerClient
from .handler import INSTRUCTIONS


@asynccontextmanager
async def bitdeer_session(client=None):
    """Yield decide(prompt, schema) -> dict backed by Bitdeer. No tools are ever offered to the model."""
    client = client or BitdeerClient()

    async def decide(prompt, schema):
        return await client.complete_json(INSTRUCTIONS, prompt, schema)

    yield decide
