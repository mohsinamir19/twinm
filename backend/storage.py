"""Tiny JSON storage used by chat memory and the workspace (schedule/tasks/notes).

Local files by default, S3 when USE_S3=true (same switch the project already uses).
"""
import json
import os
import re
from typing import Any

from dotenv import load_dotenv

load_dotenv()

USE_S3 = os.getenv("USE_S3", "false").lower() == "true"
S3_BUCKET = os.getenv("S3_BUCKET", "")
MEMORY_DIR = os.getenv("MEMORY_DIR", "../memory")

if USE_S3:
    import boto3
    from botocore.exceptions import ClientError

    _s3 = boto3.client("s3")

# Keys end up in file names / S3 keys, so only allow safe characters (blocks "../x").
_SAFE_KEY = re.compile(r"^[A-Za-z0-9_-]{1,100}$")


def safe_key(key: str) -> str:
    if not key or not _SAFE_KEY.match(key):
        raise ValueError("invalid key")
    return key


def load_json(key: str, default: Any) -> Any:
    name = f"{safe_key(key)}.json"
    if USE_S3:
        try:
            obj = _s3.get_object(Bucket=S3_BUCKET, Key=name)
            return json.loads(obj["Body"].read().decode("utf-8"))
        except ClientError as e:
            if e.response["Error"]["Code"] == "NoSuchKey":
                return default
            raise
    path = os.path.join(MEMORY_DIR, name)
    if os.path.exists(path):
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    return default


def save_json(key: str, data: Any) -> None:
    name = f"{safe_key(key)}.json"
    body = json.dumps(data, indent=2, ensure_ascii=False)
    if USE_S3:
        _s3.put_object(
            Bucket=S3_BUCKET, Key=name, Body=body, ContentType="application/json"
        )
        return
    os.makedirs(MEMORY_DIR, exist_ok=True)
    with open(os.path.join(MEMORY_DIR, name), "w", encoding="utf-8") as f:
        f.write(body)


def delete_json(key: str) -> None:
    name = f"{safe_key(key)}.json"
    if USE_S3:
        _s3.delete_object(Bucket=S3_BUCKET, Key=name)
        return
    path = os.path.join(MEMORY_DIR, name)
    if os.path.exists(path):
        os.remove(path)
