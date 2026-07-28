import base64
import json

import anthropic

from . import config

_client = None


def _get_client() -> anthropic.Anthropic:
    global _client
    if _client is None:
        _client = anthropic.Anthropic(api_key=config.ANTHROPIC_API_KEY)
    return _client


def _image_block(image_path: str) -> dict:
    with open(image_path, "rb") as f:
        data = base64.standard_b64encode(f.read()).decode("utf-8")
    return {
        "type": "image",
        "source": {"type": "base64", "media_type": "image/png", "data": data},
    }


def ask_structured(image_path: str, prompt: str, tool_name: str, input_schema: dict) -> dict:
    """Send one screenshot + prompt to Claude, forcing a structured tool-call reply.

    Returns the validated dict Claude passed as the tool's input.
    """
    tool = {
        "name": tool_name,
        "description": "Report the requested information extracted from the screenshot.",
        "input_schema": input_schema,
    }
    response = _get_client().messages.create(
        model=config.CLAUDE_MODEL,
        max_tokens=2048,
        tools=[tool],
        tool_choice={"type": "tool", "name": tool_name},
        messages=[
            {
                "role": "user",
                "content": [
                    _image_block(image_path),
                    {"type": "text", "text": prompt},
                ],
            }
        ],
    )
    for block in response.content:
        if block.type == "tool_use" and block.name == tool_name:
            return block.input
    raise RuntimeError(f"Claude did not return the expected {tool_name} tool call: {response.content}")
