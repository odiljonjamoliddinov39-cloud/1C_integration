from functools import lru_cache

import redis

from app.config import get_settings


@lru_cache
def get_redis() -> redis.Redis:
    settings = get_settings()
    # redis-py 8 defaults to a 5 s socket timeout, which would cut off the blocking BLPOP that
    # waits up to agent_command_timeout for the agent's reply.
    return redis.Redis.from_url(
        settings.redis_url, decode_responses=True, socket_timeout=settings.agent_command_timeout + 15
    )
